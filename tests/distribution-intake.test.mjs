import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDistributionIntakeRecord,
  distributionLicenseInventory,
  distributionManifestDigest,
  extractDistributionIssueCoordinates,
  fetchFixedDistribution,
  validateDistributionComponents,
  validateDistributionManifest,
} from '../scripts/distribution-intake-lib.mjs'

const SHA = 'a'.repeat(40)

function manifest() {
  return {
    schema: 'omdsh-distribution/v1',
    id: 'starter-pack',
    version: '1.0.0',
    channel: 'preview',
    title: '起步整合包',
    summary: '一组经过固定来源审核的开发工具插件。',
    translations: { en: { title: 'Starter pack', summary: 'A fixed-source collection of development tools.' } },
    maintainer: { name: 'example', url: 'https://github.com/example' },
    compatibility: { harness: 'official-profile/v1', declared: 'Verified with the synthetic RC6 fixture.' },
    agentPreset: { mode: 'builtin', id: 'code' },
    useCases: [{ id: 'coding', title: '编码', translations: { en: 'Coding' } }],
    items: [{ projectId: 'example-plugin', releaseId: 'example-plugin@1.0.0', enabled: true }],
    application: {
      candidate: 'required',
      confirmation: 'required',
      recovery: 'managed-profile-generation',
      externalSideEffects: 'not-covered',
    },
  }
}

function registry() {
  return {
    schema: 'omdsh-registry/v1',
    snapshotId: `sha256:${'1'.repeat(64)}`,
    entries: [{
      id: 'example-plugin',
      license: 'MIT',
      releases: [{
        id: 'example-plugin@1.0.0',
        state: 'active',
        install: { mode: 'profile-bundle' },
        management: { mode: 'transactional' },
      }],
    }],
  }
}

test('Distribution source validation stays flat, preset-bound, and Registry-bound', () => {
  const value = manifest()
  assert.deepEqual(validateDistributionManifest(value), [])
  assert.deepEqual(validateDistributionComponents(value, registry()), [])
  const missing = structuredClone(registry())
  missing.entries = []
  assert.match(validateDistributionComponents(value, missing).join('; '), /not present in the current Registry/)
  const executable = structuredClone(value)
  executable.command = 'npm install anything'
  assert.match(validateDistributionManifest(executable).join('; '), /unexpected fields/)
})

test('local Experimental Packs may describe an author-owned fixed source and its SPDX license', () => {
  const value = manifest()
  value.items.push({
    type: 'source',
    id: 'my-plugin',
    packageName: '@example/my-plugin',
    version: '0.1.0',
    enabled: true,
    license: { expression: 'Apache-2.0', source: 'package-manifest' },
    source: { repository: 'https://github.com/example/my-plugin', ref: SHA },
    install: { mode: 'profile-bundle', spec: `github:example/my-plugin#${SHA}` },
  })
  assert.deepEqual(validateDistributionManifest(value), [])
  assert.match(validateDistributionComponents(value, registry()).join('; '), /local Experimental Packs/)
  assert.deepEqual(distributionLicenseInventory(value, registry()).map((item) => ({
    id: item.componentId, expression: item.expression, family: item.family,
  })), [
    { id: 'example-plugin', expression: 'MIT', family: 'permissive' },
    { id: 'my-plugin', expression: 'Apache-2.0', family: 'permissive' },
  ])
  value.items[1].license.expression = 'MIT Apache-2.0'
  assert.match(validateDistributionManifest(value).join('; '), /SPDX expression/)
  value.items[1].license.expression = '(MIT OR Apache-2.0) AND GPL-3.0-only'
  assert.deepEqual(validateDistributionManifest(value), [])
})

test('Distribution digest is independent of object key order', () => {
  const value = manifest()
  const reordered = Object.fromEntries(Object.entries(value).reverse())
  assert.equal(distributionManifestDigest(value), distributionManifestDigest(reordered))
})

test('Distribution Issue fields require a public repository, full commit, and safe JSON path', () => {
  const event = {
    issue: {
      number: 7,
      body: [
        '### 维护仓库 / Maintainer repository',
        'https://github.com/example/distributions',
        '',
        '### 完整 commit SHA / Full commit SHA',
        SHA,
        '',
        '### Manifest 路径 / Manifest path',
        'packs/starter.json',
        '',
        '### 兼容性与运行证据 / Compatibility and run evidence',
        'RC6 candidate Profile passed one real task.',
      ].join('\n'),
    },
  }
  assert.deepEqual(extractDistributionIssueCoordinates(event), {
    repository: 'https://github.com/example/distributions',
    ref: SHA,
    path: 'packs/starter.json',
    compatibilityEvidence: 'RC6 candidate Profile passed one real task.',
  })
  event.issue.body = event.issue.body.replace('packs/starter.json', '../starter.json')
  assert.throws(() => extractDistributionIssueCoordinates(event), /unsafe/)
})

test('fixed-source fetch resolves the exact public commit before creating pending review', async () => {
  const value = manifest()
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/repos/example/distributions')) return Response.json({ private: false, disabled: false, archived: false })
    if (url.endsWith(`/git/commits/${SHA}`)) return Response.json({ sha: SHA })
    if (url.includes(`/contents/packs/starter.json?ref=${SHA}`)) {
      return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') })
    }
    return new Response('', { status: 404 })
  }
  const coordinates = { repository: 'https://github.com/example/distributions', ref: SHA, path: 'packs/starter.json' }
  const fetched = await fetchFixedDistribution(coordinates, { fetchImpl })
  const record = createDistributionIntakeRecord({
    coordinates,
    manifest: fetched.manifest,
    registry: registry(),
    issueNumber: 7,
    compatibilityEvidence: 'Synthetic RC6 evidence.',
  })
  assert.equal(calls.length, 3)
  assert.equal(record.review.state, 'pending-review')
  assert.equal(record.publication.state, 'ineligible')
  assert.equal(record.verification.registrySnapshotId, registry().snapshotId)
})
