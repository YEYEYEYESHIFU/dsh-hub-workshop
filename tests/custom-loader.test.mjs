import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createHarnessPlan, runHarnessPlan } from '../scripts/typed-harness-lib.mjs'
import { createIntakeRecord, evaluateRecord, validateSubmission } from '../scripts/intake-lib.mjs'

const baseline = JSON.parse(await readFile(new URL('../official-baseline.json', import.meta.url), 'utf8'))
const descriptor = {
  id: 'mygo-contract',
  version: '1.0.0',
  match: { installAdapter: 'dev.omdsh.mygo-loader', protocol: 'dev.omdsh.mygo-v1' },
  implementation: { type: 'bundled-module', module: 'scripts/loader-adapters/mygo.mjs', export: 'createAdapter' },
  execution: 'trusted-ephemeral',
  authority: 'catalog-only',
  lifecycle: ['inspect', 'install-candidate', 'ready', 'invoke', 'inject-failure', 'activate', 'update', 'disable', 'remove', 'rollback', 'cleanup'],
}

function submission() {
  return {
    schema: 'omdsh-workshop-submission/v2',
    operation: 'create-project',
    project: {
      id: 'mygo-example',
      displayName: 'MyGo Example',
      summary: 'A synthetic namespaced loader contract fixture.',
      kind: 'extension',
      category: 'developer-tools',
      tags: ['loader'],
      repository: 'https://github.com/omdsh-dev/mygo-example',
      path: null,
      author: { name: 'omdsh-dev', url: 'https://github.com/omdsh-dev' },
      license: 'MIT',
    },
    release: {
      version: '1.0.0',
      ref: '7777777777777777777777777777777777777777',
      updatedAt: '2026-08-15T00:00:00.000Z',
      channel: 'stable',
      compatibility: 'Exact @deepseek-ai/dsh@0.1.0-rc.6 support.',
      changelog: 'Initial synthetic loader fixture.',
      capabilities: { requiresFabric: false, deepHook: false, restartRequired: true },
      profileBundle: null,
      updateFrom: null,
    },
    management: {
      method: 'loader-adapter',
      protocol: 'dev.omdsh.mygo-v1',
      label: 'Use the reviewed MyGo adapter',
      instructions: 'Resolved only through the trusted Hub Loader Adapter registry.',
      source: null,
    },
    declarations: {
      permissions: 'No undeclared permissions.',
      testing: 'Exercise the complete loader lifecycle in an ephemeral workspace.',
      trustedPublisherRequested: false,
      installScriptsMustRemainDisabled: true,
    },
    packageManifest: {
      schema: 'omdsh-workshop-package/v1',
      type: 'plugin',
      integration: { protocol: 'dev.omdsh.mygo-v1', artifact: 'mygo.plugin.json' },
      install: { mode: 'isolated-trial', adapter: 'dev.omdsh.mygo-loader', failurePolicy: 'discard-process', touchesCurrentBeforeActivation: false },
      lifecycle: { activation: 'restart-plugin', dispose: 'supported' },
      permissions: [],
      compatibility: { dshVersions: ['0.1.0-rc.6'] },
      capability: { id: 'mygo-probe', kind: 'service', invocation: 'invoke the fixture probe', expected: 'fixture-ok' },
      evidence: { install: null, failureIsolation: null, hotReload: null, remove: null },
    },
  }
}

test('a custom middle loader uses the generic Harness lifecycle without a core type branch', async () => {
  const manifest = submission()
  assert.deepEqual(validateSubmission(manifest), [])
  const intake = createIntakeRecord(manifest, baseline)
  assert.deepEqual(evaluateRecord(intake, baseline), [])
  assert.equal(intake.registry.state, 'ineligible')
  const plan = createHarnessPlan(manifest, baseline, descriptor)
  assert.deepEqual(plan.loaderAdapter, {
    id: 'mygo-contract',
    version: '1.0.0',
    execution: 'trusted-ephemeral',
    authority: 'catalog-only',
  })
  assert.ok(plan.steps.some((step) => step.id === 'capability.invoke' && step.executor === 'loader'))
  assert.ok(plan.steps.some((step) => step.id === 'recovery.adapter'))

  const report = await runHarnessPlan(plan, {
    name: 'synthetic-mygo-adapter',
    trustedSourceExecution: true,
    async run(step) {
      return {
        status: 'passed',
        evidence: `${step.id}: synthetic contract result`,
        facts: structuredClone(step.expectedFacts),
        ...(step.id === 'capability.invoke' ? { capability: { ...plan.capability, observed: 'fixture-ok' } } : {}),
      }
    },
    async cleanup() {
      return { status: 'passed', evidence: 'synthetic workspace removed', facts: { workspaceRemoved: true } }
    },
  }, { verifiedAt: '2026-08-15T00:00:00.000Z', verifier: 'custom-loader-test' })
  assert.equal(report.status, 'passed')
  assert.deepEqual(report.loaderAdapter, plan.loaderAdapter)
})
