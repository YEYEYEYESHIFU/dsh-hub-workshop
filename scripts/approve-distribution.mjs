#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { approveDistributionRecord } from './distribution-approval-lib.mjs'
import { buildDistributionIntakeQueue } from './build-distribution-intake-queue.mjs'
import { buildDistributionsFeed } from './build-distributions-feed.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const content = (value) => `${JSON.stringify(value, null, 2)}\n`

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? '' : process.argv[index + 1] || ''
}

const command = process.argv[2]
const distributionId = process.argv[3]
if (!['inspect', 'approve'].includes(command) || !distributionId) {
  throw new Error('usage: node scripts/approve-distribution.mjs <inspect|approve> <distribution@version> [--reviewer ID] [--notes TEXT]')
}
const [record, admissions, registry] = await Promise.all([
  json(`distribution-intake/records/${distributionId}.json`),
  json('distribution-admissions.json'),
  json('registry-v1.json'),
])

if (command === 'inspect') {
  console.log(JSON.stringify({
    distributionId,
    source: record.source,
    components: record.manifest.items,
    registrySnapshotId: record.verification.registrySnapshotId,
    currentRegistrySnapshotId: registry.snapshotId,
    review: record.review,
    publication: record.publication,
    action: record.verification.registrySnapshotId === registry.snapshotId
      ? 'approve-composition-with-one-explicit-review'
      : 'blocked-until-components-are-revalidated',
  }, null, 2))
  process.exit(0)
}

const reviewer = option('reviewer')
if (!reviewer) throw new Error('--reviewer is required for approval')
if (record.verification.registrySnapshotId !== registry.snapshotId) throw new Error('Distribution Registry snapshot is stale; re-run fixed-source intake before approval')
const reviewedAt = new Date().toISOString()
const result = approveDistributionRecord({ record, reviewer, reviewedAt, notes: option('notes') })
admissions.admissions = [...admissions.admissions.filter((item) => item.id !== result.admission.id), result.admission]
  .sort((left, right) => left.id.localeCompare(right.id))
admissions.updatedAt = reviewedAt
await writeFile(resolve(ROOT, `distribution-intake/records/${distributionId}.json`), content(result.record))
await writeFile(resolve(ROOT, 'distribution-admissions.json'), content(admissions))
await buildDistributionIntakeQueue({ root: ROOT })
await buildDistributionsFeed({ root: ROOT })
console.log(`approved ${distributionId}; composition published without changing component installation authority`)
