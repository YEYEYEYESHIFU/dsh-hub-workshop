import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { approveDistributionRecord } from '../scripts/distribution-approval-lib.mjs'
import { buildDistributionIntakeQueue } from '../scripts/build-distribution-intake-queue.mjs'
import { buildDistributionsFeed } from '../scripts/build-distributions-feed.mjs'

const SNAPSHOT = `sha256:${'2'.repeat(64)}`
const REVIEWED_AT = '2026-08-15T01:02:03.000Z'

function manifest() {
  return {
    schema: 'omdsh-distribution/v1',
    id: 'starter-pack',
    version: '1.0.0',
    channel: 'stable',
    title: '起步整合包',
    summary: '一组只引用 Registry 固定版本的开发插件。',
    translations: { en: { title: 'Starter pack', summary: 'A Registry-pinned development plugin collection.' } },
    maintainer: { name: 'example', url: 'https://github.com/example' },
    compatibility: { harness: 'official-profile/v1', declared: 'Verified with a synthetic RC6 candidate Profile.' },
    agentPreset: { mode: 'builtin', id: 'code' },
    useCases: [{ id: 'coding', title: '编码', translations: { en: 'Coding' } }],
    items: [{ projectId: 'example-plugin', releaseId: 'example-plugin@1.0.0', enabled: true }],
    application: { candidate: 'required', confirmation: 'required', recovery: 'managed-profile-generation', externalSideEffects: 'not-covered' },
  }
}

function pendingRecord() {
  return {
    schema: 'omdsh-distribution-intake/v1',
    id: 'starter-pack@1.0.0',
    source: { repository: 'https://github.com/example/distributions', ref: 'a'.repeat(40), path: 'packs/starter.json' },
    manifest: manifest(),
    submission: { issue: 7, compatibilityEvidence: 'Synthetic RC6 evidence.' },
    verification: { fixedSource: 'passed', components: 'passed', registrySnapshotId: SNAPSHOT },
    review: { state: 'pending-review' },
    publication: { state: 'ineligible', reason: 'human-composition-review-required' },
  }
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'omdsh-distribution-test-'))
  await mkdir(resolve(root, 'distribution-intake/records'), { recursive: true })
  const registry = {
    schema: 'omdsh-registry/v1',
    revision: 1,
    generatedAt: REVIEWED_AT,
    origins: ['https://hub.omdsh.dev/registry-v1.json'],
    snapshotId: SNAPSHOT,
    entries: [{ id: 'example-plugin', license: 'MIT', releases: [{ id: 'example-plugin@1.0.0', version: '1.0.0', install: { mode: 'profile-bundle', packageName: '@example/plugin' } }] }],
  }
  await writeFile(resolve(root, 'registry-v1.json'), JSON.stringify(registry))
  await writeFile(resolve(root, 'official-baseline.json'), JSON.stringify({ runtime: { package: '@deepseek-ai/dsh', version: '0.1.0-rc.6', integrity: 'sha512:test' } }))
  return root
}

test('one composition approval creates an independent feed without elevating components', async () => {
  const root = await fixture()
  const result = approveDistributionRecord({ record: pendingRecord(), reviewer: 'synthetic-reviewer', reviewedAt: REVIEWED_AT, notes: 'Composition only.' })
  await writeFile(resolve(root, `distribution-intake/records/${result.record.id}.json`), JSON.stringify(result.record))
  await writeFile(resolve(root, 'distribution-admissions.json'), JSON.stringify({ schema: 'omdsh-distribution-admissions/v1', updatedAt: REVIEWED_AT, admissions: [result.admission] }))
  await buildDistributionIntakeQueue({ root })
  const feed = await buildDistributionsFeed({ root, write: false })
  assert.equal(feed.distributions.length, 1)
  assert.equal(feed.distributions[0].latestRelease, result.record.id)
  assert.equal(feed.policy.componentAuthority, 'never-elevated-by-composition')
  assert.equal(feed.distributions[0].releases[0].resolution.format, 'omdsh-profile-pack/v1')
  assert.equal(feed.distributions[0].releases[0].resolution.signedEnvelope, 'omdsh-profile-pack-envelope/v1')
  assert.equal(feed.distributions[0].releases[0].licenses[0].expression, 'MIT')
  assert.equal(feed.distributions[0].releases[0].licenses[0].family, 'permissive')
})

test('feed build fails closed when a component leaves the bound Registry', async () => {
  const root = await fixture()
  const result = approveDistributionRecord({ record: pendingRecord(), reviewer: 'synthetic-reviewer', reviewedAt: REVIEWED_AT })
  await writeFile(resolve(root, `distribution-intake/records/${result.record.id}.json`), JSON.stringify(result.record))
  await writeFile(resolve(root, 'distribution-admissions.json'), JSON.stringify({ schema: 'omdsh-distribution-admissions/v1', updatedAt: REVIEWED_AT, admissions: [result.admission] }))
  await buildDistributionIntakeQueue({ root })
  const registry = JSON.parse(await readFile(resolve(root, 'registry-v1.json'), 'utf8'))
  registry.entries = []
  await writeFile(resolve(root, 'registry-v1.json'), JSON.stringify(registry))
  await assert.rejects(() => buildDistributionsFeed({ root, write: false }), /not present in the current Registry/)
})
