import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { applyEvidence, createIntakeRecord } from '../scripts/intake-lib.mjs'
import { validateHarnessPlanBindings } from '../scripts/build-intake-queue.mjs'
import { createHarnessPlan, harnessReportToEvidence, runHarnessPlan, validateHarnessPlan, validateHarnessReport } from '../scripts/typed-harness-lib.mjs'

const baseline = JSON.parse(await readFile(new URL('../official-baseline.json', import.meta.url), 'utf8'))
const SHA = '4'.repeat(40)
const NOW = '2026-08-14T06:00:00.000Z'

const typeFacts = {
  profile: {
    method: 'profile-bundle',
    protocol: 'harness-profile',
    install: { mode: 'transactional', adapter: 'profile-bundle', failurePolicy: 'generation-rollback', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'hot-reload', dispose: 'supported' },
  },
  repository: {
    method: 'repository-plugin',
    protocol: 'harness-repository',
    install: { mode: 'isolated-trial', adapter: 'repository-plugin', failurePolicy: 'discard-candidate', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'restart-plugin', dispose: 'supported' },
  },
  mcp: {
    method: 'guided',
    protocol: 'mcp',
    install: { mode: 'isolated-trial', adapter: 'mcp-server', failurePolicy: 'discard-process', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'restart-plugin', dispose: 'supported' },
  },
  cordis: {
    method: 'guided',
    protocol: 'harness-cordis',
    install: { mode: 'guided', adapter: 'third-party', failurePolicy: 'manual', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'hot-reload', dispose: 'supported' },
  },
  skill: {
    method: 'guided',
    protocol: 'skill',
    install: { mode: 'guided', adapter: 'skill', failurePolicy: 'manual', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'immediate', dispose: 'unknown' },
  },
  thirdParty: {
    method: 'guided',
    protocol: 'third-party',
    install: { mode: 'guided', adapter: 'third-party', failurePolicy: 'manual', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'immediate', dispose: 'unknown' },
  },
}

function submission(type) {
  const facts = typeFacts[type]
  const id = `harness-${type.toLowerCase()}`
  const artifact = facts.protocol === 'mcp' ? 'server.json' : facts.protocol === 'skill' ? 'SKILL.md' : facts.protocol === 'harness-repository' ? '.dsh-plugin/manifest.json' : 'package.json'
  const profileBundle = facts.method === 'profile-bundle' ? { packageName: '@example/typed-harness', spec: `github:example/${id}#${SHA}` } : null
  const source = facts.method === 'repository-plugin' ? `github:example/${id}#${SHA}&path:/.dsh-plugin` : null
  const executable = ['profile', 'repository', 'mcp', 'cordis'].includes(type)
  return {
    schema: 'omdsh-workshop-submission/v2',
    operation: ['profile', 'repository'].includes(type) ? 'add-release' : 'create-project',
    project: {
      id,
      displayName: `Harness ${type}`,
      summary: 'Synthetic typed Harness fixture.',
      kind: facts.protocol === 'mcp' ? 'mcp' : facts.protocol === 'skill' ? 'skill' : 'extension',
      category: 'developer-tools',
      tags: ['dsh-plugin'],
      repository: `https://github.com/example/${id}`,
      path: null,
      author: { name: 'example', url: 'https://github.com/example' },
      license: 'MIT',
      media: null,
    },
    release: {
      version: '1.0.0',
      ref: SHA,
      updatedAt: NOW,
      channel: 'stable',
      compatibility: 'Synthetic current-baseline fixture.',
      changelog: 'Typed Harness fixture.',
      capabilities: { requiresFabric: false, deepHook: false, restartRequired: facts.lifecycle.activation.startsWith('restart-') },
      profileBundle,
      updateFrom: ['profile', 'repository'].includes(type) ? { version: '0.9.0', ref: '3'.repeat(40) } : null,
    },
    management: {
      method: facts.method,
      protocol: facts.protocol,
      label: facts.method === 'guided' ? 'View integration guide' : 'Install after admission',
      instructions: facts.method === 'repository-plugin'
        ? `Use ${source} in an isolated candidate Profile.`
        : facts.method === 'guided'
          ? `Review the fixed source at https://github.com/example/${id}/tree/${SHA}.`
          : 'Install the fixed package in an isolated candidate Profile.',
      source,
    },
    declarations: {
      permissions: 'Synthetic fixture permissions only.',
      testing: 'Run the typed Harness in an ephemeral workspace.',
      trustedPublisherRequested: false,
      installScriptsMustRemainDisabled: true,
    },
    packageManifest: {
      schema: 'omdsh-workshop-package/v1',
      type: 'plugin',
      integration: {
        protocol: facts.protocol,
        artifact,
        ...(facts.protocol === 'mcp' ? {
          mcp: {
            protocolVersions: ['2026-07-28'],
            serverManifest: 'server.json',
            registrySchema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
          },
        } : {}),
      },
      install: facts.install,
      lifecycle: facts.lifecycle,
      permissions: ['network:outbound'],
      ...(executable ? {
        capability: {
          id: 'tool.synthetic',
          kind: 'tool',
          invocation: 'invoke tool.synthetic with fixture input',
          expected: 'fixture-result',
        },
      } : {}),
      evidence: {
        install: 'tests/install.mjs',
        failureIsolation: 'tests/failure-isolation.mjs',
        hotReload: facts.lifecycle.activation === 'hot-reload' ? 'tests/hot-reload.mjs' : null,
        remove: 'tests/remove.mjs',
      },
    },
  }
}

function passingAdapter(overrides = {}) {
  let calls = 0
  return {
    name: 'synthetic-trusted-adapter',
    trustedSourceExecution: true,
    get calls() { return calls },
    async run(step) {
      calls += 1
      const override = overrides[step.id]
      if (override) return override
      return {
        status: 'passed',
        evidence: `${step.id}: deterministic synthetic evidence`,
        facts: structuredClone(step.expectedFacts),
        ...(step.id === 'capability.invoke' ? {
          capability: {
            id: 'tool.synthetic',
            kind: 'tool',
            invocation: 'invoke tool.synthetic with fixture input',
            expected: 'fixture-result',
            observed: 'fixture-result',
          },
        } : {}),
      }
    },
    async cleanup() {
      return { status: 'passed', evidence: 'ephemeral workspace removed', facts: { workspaceRemoved: true } }
    },
  }
}

test('typed plans cover Profile, Repository, MCP, Cordis, Skill, and third-party protocols', () => {
  const plans = Object.fromEntries(Object.keys(typeFacts).map((type) => [type, createHarnessPlan(submission(type), baseline)]))
  assert.ok(plans.profile.steps.some((step) => step.id === 'recovery.generation'))
  assert.ok(plans.repository.steps.some((step) => step.id === 'recovery.candidate'))
  assert.ok(plans.mcp.steps.some((step) => step.id === 'mcp.discover'))
  assert.ok(plans.mcp.steps.some((step) => step.id === 'mcp.tools-list'))
  assert.ok(plans.cordis.steps.some((step) => step.id === 'cordis.init'))
  assert.ok(plans.skill.steps.some((step) => step.id === 'skill.frontmatter'))
  assert.ok(plans.thirdParty.steps.some((step) => step.id === 'guide.reproducibility'))
  for (const plan of Object.values(plans)) {
    assert.deepEqual(validateHarnessPlan(plan), [])
    assert.equal(plan.policy.sourceExecution, 'disabled-until-explicitly-trusted')
    assert.equal(plan.policy.workspace, 'ephemeral')
    assert.equal(plan.policy.installScripts, 'disabled')
  }
})

test('every v2 Intake record is bound to exactly one matching current-baseline plan', () => {
  const manifest = submission('profile')
  const record = createIntakeRecord(manifest, baseline)
  const plan = createHarnessPlan(manifest, baseline)
  assert.deepEqual(validateHarnessPlanBindings([record], [plan], baseline), [])
  assert.match(validateHarnessPlanBindings([record], [], baseline).join('; '), /requires a typed Harness plan/)
  const wrongSource = structuredClone(plan)
  wrongSource.source.ref = '5'.repeat(40)
  assert.match(validateHarnessPlanBindings([record], [wrongSource], baseline).join('; '), /source does not match/)
  assert.match(validateHarnessPlanBindings([], [plan], baseline).join('; '), /orphan typed Harness plan/)
})

test('every installation and protocol type completes its own deterministic adapter contract', async () => {
  const repositoryBaseline = structuredClone(baseline)
  repositoryBaseline.contracts.repositoryPlugin.status = 'available'
  const cases = [
    ['profile', baseline, 'evidence-ready'],
    ['repository', repositoryBaseline, 'evidence-ready'],
    ['mcp', baseline, 'catalog-only'],
    ['cordis', baseline, 'catalog-only'],
    ['skill', baseline, 'catalog-only'],
    ['thirdParty', baseline, 'catalog-only'],
  ]
  for (const [type, currentBaseline, registryState] of cases) {
    const plan = createHarnessPlan(submission(type), currentBaseline)
    const report = await runHarnessPlan(plan, passingAdapter(), { verifiedAt: NOW, verifier: `synthetic-${type}` })
    assert.equal(report.status, 'passed', type)
    assert.equal(report.claims.protocolCompatibility.state, 'verified', type)
    assert.equal(report.claims.registryReadiness.state, registryState, type)
  }
})

test('Harness refuses to execute without explicit adapter trust', async () => {
  const plan = createHarnessPlan(submission('profile'), baseline)
  await assert.rejects(runHarnessPlan(plan, { run() {}, cleanup() {} }), /explicitly trusted adapter/)
})

test('Harness fails closed when an adapter reports a different capability than the fixed plan', async () => {
  const plan = createHarnessPlan(submission('profile'), baseline)
  const adapter = passingAdapter({
    'capability.invoke': {
      status: 'passed',
      evidence: 'adapter attempted to substitute a different target',
      facts: { capabilityObserved: true },
      capability: {
        id: 'tool.substituted',
        kind: 'tool',
        invocation: 'invoke tool.substituted',
        expected: 'different-result',
        observed: 'different-result',
      },
    },
  })
  const report = await runHarnessPlan(plan, adapter, { verifiedAt: NOW })
  assert.equal(report.status, 'failed')
  assert.match(report.steps.find((step) => step.id === 'capability.invoke').evidence, /Harness contract mismatch/)
  assert.equal(report.steps.find((step) => step.id === 'failure.inject-candidate').status, 'blocked')
})

test('transactional Harness produces v2 evidence only after lifecycle, isolation, and cleanup pass', async () => {
  const manifest = submission('profile')
  const plan = createHarnessPlan(manifest, baseline)
  const report = await runHarnessPlan(plan, passingAdapter(), { verifiedAt: NOW, verifier: 'synthetic-test' })
  assert.equal(report.status, 'passed')
  assert.equal(report.claims.seamlessInstall.state, 'verified')
  assert.equal(report.claims.failureIsolation.state, 'verified')
  assert.equal(report.claims.hotReload.state, 'verified')
  assert.equal(report.claims.registryReadiness.state, 'evidence-ready')
  assert.deepEqual(validateHarnessReport(report, plan), [])

  const record = createIntakeRecord(manifest, baseline)
  record.review = { state: 'approved', reviewer: 'synthetic-reviewer', reviewedAt: NOW }
  const evidence = harnessReportToEvidence({
    record,
    report,
    baseline,
    environment: { profile: 'candidate-test', platform: 'synthetic-platform', node: '22' },
  })
  assert.equal(evidence.schema, 'omdsh-workshop-intake-evidence/v2')
  assert.equal(evidence.checks.failureIsolation.status, 'passed')
  assert.equal(evidence.checks.hotReload.status, 'passed')
  assert.equal(applyEvidence(record, evidence, baseline).registry.state, 'eligible')
  const downgraded = structuredClone(evidence)
  downgraded.schema = 'omdsh-workshop-intake-evidence/v1'
  delete downgraded.checks.failureIsolation
  delete downgraded.checks.hotReload
  assert.throws(() => applyEvidence(record, downgraded, baseline), /v2 submission requires typed Harness v2 evidence/)
})

test('an initial transactional release is fully verified without inventing a previous version', async () => {
  const manifest = submission('profile')
  manifest.operation = 'create-project'
  manifest.release.updateFrom = null
  const plan = createHarnessPlan(manifest, baseline)
  assert.equal(plan.updateFrom, null)
  assert.equal(plan.steps.some((step) => step.id === 'update-source.immutable'), false)
  assert.equal(plan.steps.some((step) => step.id === 'update.apply'), false)
  const report = await runHarnessPlan(plan, passingAdapter(), { verifiedAt: NOW, verifier: 'synthetic-initial-release' })
  assert.equal(report.status, 'passed')
  const record = createIntakeRecord(manifest, baseline)
  const evidence = harnessReportToEvidence({ record, report, baseline, environment: {} })
  assert.equal(evidence.checks.update.status, 'not-applicable')
  assert.equal(applyEvidence(record, evidence, baseline).verification.state, 'current-baseline-passed')
})

test('missing current protection fails closed and blocks later activation', async () => {
  const plan = createHarnessPlan(submission('profile'), baseline)
  const adapter = passingAdapter({
    'failure.current-unchanged': {
      status: 'passed',
      evidence: 'current generation changed unexpectedly',
      facts: { currentUnchanged: false },
    },
  })
  const report = await runHarnessPlan(plan, adapter, { verifiedAt: NOW })
  assert.equal(report.status, 'failed')
  assert.equal(report.steps.find((step) => step.id === 'failure.current-unchanged').status, 'failed')
  assert.equal(report.steps.find((step) => step.id === 'activation.switch').status, 'blocked')
  assert.equal(report.claims.failureIsolation.state, 'failed')
  assert.equal(report.cleanup.status, 'passed')
})

test('cleanup failure and credential-like evidence invalidate an otherwise passing run', async () => {
  const plan = createHarnessPlan(submission('profile'), baseline)
  const cleanupFailure = passingAdapter()
  cleanupFailure.cleanup = async () => ({ status: 'failed', evidence: 'workspace remained', facts: { workspaceRemoved: false } })
  assert.equal((await runHarnessPlan(plan, cleanupFailure, { verifiedAt: NOW })).status, 'failed')

  const secretEvidence = passingAdapter({
    'manifest.validate': {
      status: 'passed',
      evidence: `accidental github_pat_${'a'.repeat(24)}`,
      facts: { manifestValid: true },
    },
  })
  await assert.rejects(runHarnessPlan(plan, secretEvidence, { verifiedAt: NOW }), /credential or private key/)
})

test('Repository Plugin Harness stays blocked while the official public contract is unavailable', async () => {
  const plan = createHarnessPlan(submission('repository'), baseline)
  const adapter = passingAdapter()
  const report = await runHarnessPlan(plan, adapter, { verifiedAt: NOW })
  assert.deepEqual(plan.blockedReasons, ['official-repository-plugin-contract-unavailable'])
  assert.equal(report.status, 'blocked')
  assert.equal(adapter.calls, 0)
  assert.ok(report.steps.every((step) => step.status === 'blocked'))
})

test('MCP Harness verifies the official protocol independently but remains Catalog-only', async () => {
  const manifest = submission('mcp')
  const plan = createHarnessPlan(manifest, baseline)
  const report = await runHarnessPlan(plan, passingAdapter(), { verifiedAt: NOW, verifier: 'synthetic-mcp' })
  assert.equal(report.status, 'passed')
  assert.equal(report.steps.find((step) => step.id === 'mcp.discover').facts.protocolVersion, '2026-07-28')
  assert.equal(report.claims.failureIsolation.state, 'verified')
  assert.equal(report.claims.registryReadiness.state, 'catalog-only')

  const record = createIntakeRecord(manifest, baseline)
  const evidence = harnessReportToEvidence({ record, report, baseline, environment: {} })
  assert.equal(evidence.runtime, null)
  assert.equal(evidence.checks.install.status, 'not-applicable')
  assert.equal(evidence.checks.failureIsolation.status, 'not-applicable')
  assert.equal(applyEvidence(record, evidence, baseline).verification.state, 'source-evidence-passed')
})
