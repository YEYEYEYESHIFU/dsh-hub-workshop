import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildFeeds, canonicalJson, validateAdmission } from '../scripts/build-install-feeds.mjs'

const rootUrl = new URL('../', import.meta.url)
const root = fileURLToPath(rootUrl)
const json = async (path) => JSON.parse(await readFile(new URL(path, rootUrl), 'utf8'))

test('the empty Registry is deterministic and grants no install authority', async () => {
  const first = await buildFeeds({ root, write: false })
  const second = await buildFeeds({ root, write: false })
  assert.equal(canonicalJson(first), canonicalJson(second))

  const registry = first['registry-v1.json']
  assert.deepEqual(registry.entries, [])
  const workshop = first['workshop-v1.json']
  assert.deepEqual(workshop.projects, [])
  assert.deepEqual(workshop.runRecords, [])
  assert.equal(first['catalog.json'].stats.installMethods['profile-bundle'], undefined)
  assert.equal(first['catalog.json'].stats.installMethods.manual, first['catalog.json'].stats.packages)
  const sourceCatalog = await json('catalog.json')
  const admissions = await json('registry-admissions.json')
  const queue = await json('intake-queue.json')
  assert.equal(
    first['catalog.json'].updated,
    new Date(Math.max(Date.parse(sourceCatalog.updated), Date.parse(admissions.updatedAt), Date.parse(queue.generatedAt))).toISOString(),
  )
})

test('blocked candidates never leak into executable feeds', async () => {
  const output = await buildFeeds({ root, write: false })
  const admissions = await json('registry-admissions.json')
  const serialized = canonicalJson({
    registry: output['registry-v1.json'],
    workshop: output['workshop-v1.json'],
  })
  for (const candidate of admissions.blocked) {
    assert.equal(output['registry-v1.json'].entries.some((entry) => entry.id === candidate.id), false)
    assert.equal(serialized.includes(candidate.source), false)
  }
})

test('a synthetic admission fails closed when Catalog and evidence coordinates diverge', async () => {
  const catalog = await json('catalog.json')
  const audit = await json('audits/registry/7d7d-0.4.0-rc.1-rc5.json')
  const candidate = {
    id: '7d7d',
    decision: 'admitted',
    mode: 'profile-bundle',
    source: { repository: 'https://github.com/omdsh-dev/7d7d', ref: '80b6ddb779a009d378a1c30c85dfef598f527997', path: null },
    version: '0.4.0-rc.1',
    packageName: '@mattheliu/7d7d',
    spec: 'github:omdsh-dev/7d7d#80b6ddb779a009d378a1c30c85dfef598f527997',
    risk: { level: 'medium', vulnerabilityScan: 'unknown', permissions: 'reviewed', nativeCode: 'absent', installScripts: 'absent', trustedPublisher: 'unknown' },
    evidence: { sha256: 'unused-by-this-assertion' },
  }
  candidate.source.ref = '0'.repeat(40)
  assert.throws(() => validateAdmission(
    candidate,
    catalog.packages.find((item) => item.id === candidate.id),
    audit,
    candidate.evidence.sha256,
    '@deepseek-ai/dsh@0.0.1-rc.5',
  ), /ref differs from Catalog/)
})
