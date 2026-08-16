import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildAutomationPlan, buildVerificationJobs, declaredDshVersions, validateAutomationPolicy } from '../scripts/automation-policy-lib.mjs'

const policy = JSON.parse(await readFile(new URL('../automation-policy.json', import.meta.url), 'utf8'))
const baseline = JSON.parse(await readFile(new URL('../official-baseline.json', import.meta.url), 'utf8'))
const loaderRegistry = JSON.parse(await readFile(new URL('../loader-adapters.json', import.meta.url), 'utf8'))

function record(adapter, protocol, compatibility = 'Exact @deepseek-ai/dsh@0.1.0-rc.2 support.') {
  return {
    id: `example-${adapter}@1.0.0`,
    submission: {
      manifest: {
        release: { compatibility },
        management: { protocol },
        packageManifest: {
          install: { adapter },
          integration: { protocol },
          ...(adapter === 'mcp-server' ? { testing: { entry: 'server/main.mjs', arguments: {}, failureTool: 'harness-fail' } } : {})
        }
      }
    }
  }
}

test('automation policy retains the two trust boundaries', () => {
  assert.deepEqual(validateAutomationPolicy(policy), [])
  assert.equal(policy.discovery.autoAdmission, false)
  assert.equal(policy.release.productionApproval, true)
})

test('Profile verification follows the declared exact version and current baseline', () => {
  const target = record('profile-bundle', 'harness-profile')
  assert.deepEqual(declaredDshVersions(target), ['0.1.0-rc.2'])
  const result = buildVerificationJobs(target, baseline, policy, loaderRegistry)
  assert.deepEqual(result.blocked, [])
  assert.deepEqual(result.jobs.map((job) => [job.runtimeVersion, job.authority]), [
    ['0.1.0-rc.2', 'compatibility-only'],
    ['0.1.0-rc.6', 'current-baseline']
  ])
  assert.ok(result.jobs.every((job) => job.requiresTrust && job.runner === 'macos-15'))
})

test('Skill stays static, MCP requires a deterministic entry, and unavailable Repository Plugin blocks', () => {
  const skill = buildVerificationJobs(record('skill', 'skill'), baseline, policy, loaderRegistry)
  assert.equal(skill.jobs.length, 1)
  assert.equal(skill.jobs[0].requiresTrust, false)
  const mcp = record('mcp-server', 'mcp')
  delete mcp.submission.manifest.packageManifest.testing
  assert.match(buildVerificationJobs(mcp, baseline, policy, loaderRegistry).blocked.join('; '), /testing.entry/)
  assert.match(buildVerificationJobs(record('repository-plugin', 'harness-repository'), baseline, policy, loaderRegistry).blocked.join('; '), /unavailable/)
})

test('automation plan never turns a blocked release into a runnable job', () => {
  const plan = buildAutomationPlan([
    record('skill', 'skill'),
    record('repository-plugin', 'harness-repository')
  ], baseline, policy, loaderRegistry)
  assert.equal(plan.jobs.length, 1)
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.summary.admissionEligible, false)
})

test('automation plan accepts a deterministic multi-release selection', () => {
  const skill = record('skill', 'skill')
  const profile = record('profile-bundle', 'harness-profile')
  const plan = buildAutomationPlan([skill, profile], baseline, policy, loaderRegistry, [profile.id])
  assert.deepEqual(plan.releaseIds, [profile.id])
  assert.equal(plan.summary.releases, 1)
  assert.ok(plan.jobs.every((job) => job.releaseId === profile.id))
})

test('scheduler derives trust and compatibility from a registered loader descriptor', () => {
  const extended = structuredClone(loaderRegistry)
  const descriptor = structuredClone(extended.adapters[1])
  descriptor.id = 'mygo-contract'
  descriptor.match = { installAdapter: 'dev.omdsh.mygo-loader', protocol: 'dev.omdsh.mygo-v1' }
  extended.adapters.push(descriptor)
  const result = buildVerificationJobs(record('dev.omdsh.mygo-loader', 'dev.omdsh.mygo-v1'), baseline, policy, extended)
  assert.deepEqual(result.blocked, [])
  assert.deepEqual(result.jobs.map((job) => job.runtimeVersion), ['0.1.0-rc.2', '0.1.0-rc.6'])
  assert.ok(result.jobs.every((job) => job.loaderAdapter === 'mygo-contract' && job.requiresTrust))
  assert.equal(result.jobs[0].registryAuthority, 'catalog-only')
})
