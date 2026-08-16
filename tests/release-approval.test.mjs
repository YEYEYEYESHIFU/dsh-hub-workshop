import assert from 'node:assert/strict'
import test from 'node:test'

import { validateAdmission } from '../scripts/build-install-feeds.mjs'
import { createIntakeRecord } from '../scripts/intake-lib.mjs'
import { approveVerifiedRelease, sha256 } from '../scripts/release-approval-lib.mjs'
import { createHarnessPlan, runHarnessPlan } from '../scripts/typed-harness-lib.mjs'

const SHA = '1'.repeat(40)
const baseline = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../official-baseline.json', import.meta.url), 'utf8')))

function submission() {
  return {
    schema: 'omdsh-workshop-submission/v2',
    operation: 'create-project',
    project: {
      id: 'approval-fixture',
      displayName: 'Approval Fixture',
      summary: 'A deterministic Profile admission fixture.',
      kind: 'extension',
      category: 'developer-tools',
      tags: ['fixture'],
      repository: 'https://github.com/example/approval-fixture',
      path: null,
      author: { name: 'example', url: 'https://github.com/example' },
      license: 'MIT',
      media: null
    },
    release: {
      version: '1.0.0',
      ref: SHA,
      updatedAt: '2026-08-15T00:00:00.000Z',
      channel: 'stable',
      compatibility: 'Exact @deepseek-ai/dsh@0.1.0-rc.6 verification.',
      changelog: 'Initial deterministic fixture.',
      capabilities: { requiresFabric: false, deepHook: false, restartRequired: true },
      profileBundle: { packageName: '@example/approval-fixture', spec: `github:example/approval-fixture#${SHA}` },
      updateFrom: null
    },
    management: {
      method: 'profile-bundle',
      protocol: 'harness-profile',
      label: 'Verify fixture',
      instructions: 'Evaluate the fixed bundle in an isolated candidate Profile.',
      source: null
    },
    declarations: {
      permissions: 'network:none, native-code:none',
      testing: 'Synthetic typed Harness adapter.',
      trustedPublisherRequested: false,
      installScriptsMustRemainDisabled: true
    },
    packageManifest: {
      schema: 'omdsh-workshop-package/v1',
      type: 'plugin',
      integration: { protocol: 'harness-profile', artifact: 'cordis.patch.yml' },
      install: {
        mode: 'transactional',
        adapter: 'profile-bundle',
        failurePolicy: 'generation-rollback',
        touchesCurrentBeforeActivation: false
      },
      lifecycle: { activation: 'restart-profile', dispose: 'supported' },
      permissions: ['network:none', 'native-code:none'],
      capability: {
        id: 'fixture-ready',
        kind: 'service',
        invocation: 'start the candidate Profile',
        expected: 'fixture-ready'
      },
      evidence: { install: null, failureIsolation: null, hotReload: null, remove: null }
    }
  }
}

test('one explicit review projects passed current-baseline evidence into a Profile admission', async () => {
  const manifest = submission()
  const record = createIntakeRecord(manifest, baseline)
  const plan = createHarnessPlan(manifest, baseline)
  const adapter = {
    name: 'synthetic-admission-adapter',
    trustedSourceExecution: true,
    async run(step) {
      return {
        status: 'passed',
        evidence: `${step.id}: deterministic evidence`,
        facts: structuredClone(step.expectedFacts),
        ...(step.id === 'capability.invoke' ? {
          capability: {
            ...plan.capability,
            observed: plan.capability.expected
          }
        } : {})
      }
    },
    async cleanup() {
      return { status: 'passed', evidence: 'ephemeral workspace removed', facts: { workspaceRemoved: true } }
    }
  }
  const report = await runHarnessPlan(plan, adapter, {
    verifiedAt: '2026-08-15T00:00:00.000Z',
    verifier: 'synthetic-review-test'
  })
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`)
  const result = approveVerifiedRelease({
    record,
    report,
    plan,
    baseline,
    reviewer: 'synthetic-reviewer',
    reviewedAt: '2026-08-15T00:01:00.000Z',
    notes: 'Exact release reviewed in a unit test.',
    riskLevel: 'low',
    reportBytes
  })
  const catalogProject = {
    id: manifest.project.id,
    version: manifest.release.version,
    repository: manifest.project.repository,
    repositoryPath: null,
    ref: manifest.release.ref,
    workshop: {
      manifest: { status: 'valid' },
      install: { adapter: 'profile-bundle', mode: 'transactional' }
    }
  }
  assert.equal(result.record.review.state, 'approved')
  assert.equal(result.record.registry.state, 'admitted')
  assert.equal(result.admission.evidence.sha256, sha256(reportBytes))
  assert.match(result.admission.spec, /^github:example\/approval-fixture#[0-9a-f]{40}$/)
  assert.equal(validateAdmission(
    result.admission,
    catalogProject,
    report,
    sha256(reportBytes),
    `${baseline.runtime.package}@${baseline.runtime.version}`,
    plan,
    result.record
  ), true)
})
