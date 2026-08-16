#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildFeeds } from './build-install-feeds.mjs'
import { buildIntakeQueue } from './build-intake-queue.mjs'
import { approveVerifiedRelease, evidenceFileForRecord, planFileForRecord, reportFileForRecord } from './release-approval-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')

async function json(path) {
  return JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
}

function option(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1] || fallback
}

function content(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

const command = process.argv[2]
const releaseId = process.argv[3]
if (!['inspect', 'approve'].includes(command) || !releaseId) {
  throw new Error('usage: node scripts/approve-release.mjs <inspect|approve> <project@version> [--reviewer ID] [--notes TEXT] [--risk-level LEVEL]')
}

const [baseline, admissions, record] = await Promise.all([
  json('official-baseline.json'),
  json('registry-admissions.json'),
  json(`intake/records/${releaseId}.json`),
])
const reportPath = reportFileForRecord(record)
const planPath = planFileForRecord(record)
const reportBytes = await readFile(resolve(ROOT, reportPath))
const [report, plan] = await Promise.all([
  Promise.resolve(JSON.parse(reportBytes.toString('utf8'))),
  json(planPath),
])

if (command === 'inspect') {
  console.log(JSON.stringify({
    releaseId,
    management: record.classification.management,
    review: record.review,
    verification: record.verification,
    harness: { status: report.status, verifiedAt: report.verifiedAt, verifier: report.verifier },
    registryAction: report.status !== 'passed'
      ? 'blocked-until-harness-passes'
      : record.classification.management === 'transactional'
        ? 'admit-after-explicit-approval'
        : 'catalog-only',
  }, null, 2))
  process.exit(0)
}

const reviewer = option('reviewer')
if (!reviewer) throw new Error('--reviewer is required for approval')
const reviewedAt = new Date().toISOString()
const result = approveVerifiedRelease({
  record,
  report,
  plan,
  baseline,
  reviewer,
  reviewedAt,
  notes: option('notes'),
  riskLevel: option('risk-level', 'unknown'),
  reportBytes,
  environment: {
    profile: report.profileBase?.template || report.classification.protocol,
    platform: report.execution?.workspace || 'ephemeral-harness',
    node: process.versions.node,
  },
})

await mkdir(resolve(ROOT, 'intake/evidence'), { recursive: true })
await writeFile(resolve(ROOT, evidenceFileForRecord(record)), content(result.evidence))
await writeFile(resolve(ROOT, `intake/records/${releaseId}.json`), content(result.record))
if (result.admission) {
  admissions.admissions = [...admissions.admissions.filter((item) => item.id !== result.admission.id), result.admission]
    .sort((left, right) => left.id.localeCompare(right.id))
  admissions.blocked = admissions.blocked.filter((item) => item.id !== result.admission.id)
  admissions.updatedAt = reviewedAt
  await writeFile(resolve(ROOT, 'registry-admissions.json'), content(admissions))
}
await buildIntakeQueue({ root: ROOT })
await buildFeeds({ root: ROOT })
console.log(result.admission
  ? `approved and admitted ${releaseId}; unsigned deterministic feeds rebuilt`
  : `approved ${releaseId} as Catalog-only evidence; no Registry authority was granted`)
