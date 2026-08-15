import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { extractSubmissionManifest, prepareIssueIntake } from '../scripts/issue-intake-lib.mjs'

const root = new URL('..', import.meta.url).pathname
const SHA = '1'.repeat(40)

function manifest() {
  return {
    schema: 'omdsh-workshop-submission/v1',
    operation: 'create-project',
    project: {
      id: 'issue-test-plugin', displayName: 'Issue test plugin', summary: 'A deterministic automated intake test plugin.',
      kind: 'extension', category: 'developer-tools', tags: ['dsh-plugin'], repository: 'https://github.com/example/issue-test-plugin',
      path: null, author: { name: 'example', url: 'https://github.com/example' }, license: 'MIT', media: null,
    },
    release: {
      version: '1.0.0', ref: SHA, updatedAt: '2026-08-14T00:00:00.000Z', channel: 'stable',
      compatibility: 'Pending current-baseline verification.', changelog: 'Initial submission.',
      capabilities: { requiresFabric: false, deepHook: false, restartRequired: false }, profileBundle: null,
    },
    management: {
      method: 'guided', protocol: 'third-party', label: 'View integration guide',
      instructions: `Read https://github.com/example/issue-test-plugin/tree/${SHA}`, source: null,
    },
    declarations: {
      permissions: 'No additional permissions.', testing: 'Source review only.',
      trustedPublisherRequested: false, installScriptsMustRemainDisabled: true,
    },
  }
}

function manifestV2() {
  const value = manifest()
  value.schema = 'omdsh-workshop-submission/v2'
  value.project.id = 'issue-test-plugin-v2'
  value.project.repository = 'https://github.com/example/issue-test-plugin-v2'
  value.management.instructions = `Read https://github.com/example/issue-test-plugin-v2/tree/${SHA}`
  value.release.updateFrom = null
  value.packageManifest = {
    schema: 'omdsh-workshop-package/v1',
    type: 'plugin',
    integration: { protocol: 'third-party', artifact: 'index.js' },
    install: { mode: 'guided', adapter: 'third-party', failurePolicy: 'manual', touchesCurrentBeforeActivation: true },
    lifecycle: { activation: 'immediate', dispose: 'unknown' },
    permissions: [],
    evidence: { install: null, failureIsolation: null, hotReload: null, remove: null },
  }
  return value
}

function event(body) {
  return { issue: { number: 42, title: '[Submission] issue-test-plugin@1.0.0', body } }
}

function githubFetch(url) {
  if (url.endsWith('/repos/example/issue-test-plugin')) {
    return Promise.resolve(new Response(JSON.stringify({ private: false, disabled: false, archived: false, html_url: 'https://github.com/example/issue-test-plugin' })))
  }
  if (url.endsWith(`/git/commits/${SHA}`)) return Promise.resolve(new Response(JSON.stringify({ sha: SHA })))
  return Promise.resolve(new Response('{}', { status: 404 }))
}

function githubFile(value) {
  return new Response(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(value).toString('base64') }))
}

function githubV2Fetch(manifestValue, { mismatch = false } = {}) {
  return (url) => {
    if (url.endsWith('/repos/example/issue-test-plugin-v2')) {
      return Promise.resolve(new Response(JSON.stringify({ private: false, disabled: false, archived: false, html_url: manifestValue.project.repository })))
    }
    if (url.endsWith(`/git/commits/${SHA}`)) return Promise.resolve(new Response(JSON.stringify({ sha: SHA })))
    if (url.includes('/contents/package.json?')) {
      const dshWorkshop = mismatch ? { ...manifestValue.packageManifest, type: 'not-the-submitted-value' } : manifestValue.packageManifest
      return Promise.resolve(githubFile(JSON.stringify({ name: 'issue-test-plugin-v2', version: '1.0.0', dshWorkshop })))
    }
    if (url.includes('/contents/index.js?')) return Promise.resolve(githubFile('export default function plugin() {}'))
    return Promise.resolve(new Response('{}', { status: 404 }))
  }
}

test('extracts the generated manifest from a prefilled Issue body', () => {
  const value = manifest()
  assert.deepEqual(extractSubmissionManifest(`## Author Studio manifest\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), value)
  assert.throws(() => extractSubmissionManifest('no manifest'), /does not contain/)
})

test('Issue automation creates pending review only after immutable public-source preflight', async () => {
  const value = manifest()
  const prepared = await prepareIssueIntake(event(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), { root, fetchImpl: githubFetch })
  assert.equal(prepared.record.id, 'issue-test-plugin@1.0.0')
  assert.equal(prepared.record.review.state, 'pending-review')
  assert.equal(prepared.record.registry.state, 'ineligible')
  assert.match(prepared.record.tests.static.evidence, /fixed commit resolved/)
  assert.equal(prepared.plan, null)
})

test('Issue automation rejects a private source before creating an intake record', async () => {
  const value = manifest()
  const privateFetch = () => Promise.resolve(new Response(JSON.stringify({ private: true, disabled: false })))
  await assert.rejects(
    prepareIssueIntake(event(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), { root, fetchImpl: privateFetch }),
    /must be public/,
  )
})

test('v2 Issue automation binds the submitted capability manifest to fixed package.json', async () => {
  const value = manifestV2()
  const prepared = await prepareIssueIntake(event(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), { root, fetchImpl: githubV2Fetch(value) })
  assert.equal(prepared.record.id, 'issue-test-plugin-v2@1.0.0')
  assert.match(prepared.record.tests.static.evidence, /package.json/)
  assert.equal(prepared.plan.schema, 'omdsh-workshop-harness-plan/v1')
  assert.equal(prepared.plan.releaseId, prepared.record.id)
  assert.equal(prepared.plan.classification.protocol, 'third-party')
  assert.equal(prepared.plan.policy.sourceExecution, 'disabled-until-explicitly-trusted')
})

test('v2 Issue automation rejects a package manifest that is not in the fixed commit', async () => {
  const value = manifestV2()
  await assert.rejects(
    prepareIssueIntake(event(`\`\`\`json\n${JSON.stringify(value)}\n\`\`\``), { root, fetchImpl: githubV2Fetch(value, { mismatch: true }) }),
    /does not match fixed package.json/,
  )
})
