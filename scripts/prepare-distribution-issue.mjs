#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { buildDistributionIntakeQueue } from './build-distribution-intake-queue.mjs'
import { createDistributionIntakeRecord, extractDistributionIssueCoordinates, fetchFixedDistribution } from './distribution-intake-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const eventPath = process.argv[2] || process.env.GITHUB_EVENT_PATH
if (!eventPath) throw new Error('usage: node scripts/prepare-distribution-issue.mjs GITHUB_EVENT_JSON')

const event = JSON.parse(await readFile(resolve(eventPath), 'utf8'))
if (!Number.isInteger(event?.issue?.number) || event.issue.number < 1) throw new Error('GitHub Issue number is required')
const coordinates = extractDistributionIssueCoordinates(event)
const [{ manifest }, registry] = await Promise.all([
  fetchFixedDistribution(coordinates, { token: process.env.GITHUB_TOKEN || '' }),
  readFile(resolve(ROOT, 'registry-v1.json'), 'utf8').then(JSON.parse),
])
const record = createDistributionIntakeRecord({
  coordinates,
  manifest,
  registry,
  issueNumber: event.issue.number,
  compatibilityEvidence: coordinates.compatibilityEvidence,
})
const recordPath = resolve(ROOT, 'distribution-intake/records', `${record.id}.json`)
await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
await buildDistributionIntakeQueue({ root: ROOT })

const runId = String(process.env.GITHUB_RUN_ID || 'local').replace(/[^0-9A-Za-z-]/g, '')
const outputs = {
  branch: `automation/distribution-${event.issue.number}-${runId}`,
  issue_number: String(event.issue.number),
  record_id: record.id,
  record_path: `distribution-intake/records/${basename(recordPath)}`,
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
}

console.log(`prepared ${record.id} from Issue #${event.issue.number}; all components remain bound to Registry ${registry.snapshotId}`)
