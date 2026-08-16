#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFeeds } from './build-install-feeds.mjs'
import { buildIntakeQueue } from './build-intake-queue.mjs'
import { evidenceFileForRecord, planFileForRecord, reportFileForRecord, synchronizeHarnessEvidence } from './release-approval-lib.mjs'
import { validateHarnessReport } from './typed-harness-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')

async function json(path, root = ROOT) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'))
}

function content(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function exclusionState(record) {
  if (record.verification.state === 'current-baseline-passed') {
    return { reason: 'review-approval-required', runtimeVerification: 'passed' }
  }
  if (record.verification.state === 'source-evidence-passed') {
    return { reason: 'guided-catalog-only', runtimeVerification: 'not-applicable' }
  }
  return null
}

export async function syncHarnessEvidence({ root = ROOT } = {}) {
  const [baseline, admissions, names] = await Promise.all([
    json('official-baseline.json', root),
    json('registry-admissions.json', root),
    readdir(resolve(root, 'intake/records')),
  ])
  const prepared = []
  const blockedReports = []
  const skipped = []
  for (const name of names.filter((value) => value.endsWith('.json')).sort()) {
    const record = await json(`intake/records/${name}`, root)
    const reportPath = reportFileForRecord(record)
    const planPath = planFileForRecord(record)
    let report
    let plan
    try {
      [report, plan] = await Promise.all([json(reportPath, root), json(planPath, root)])
    } catch {
      skipped.push({ id: record.id, reason: 'report-or-plan-missing' })
      continue
    }
    const reportErrors = validateHarnessReport(report, plan)
    if (reportErrors.length > 0) throw new Error(`${record.id}: invalid Harness report: ${reportErrors.join('; ')}`)
    if (report.status === 'blocked') {
      const blockedRecord = structuredClone(record)
      const blocker = report.steps.find((step) => step.status === 'blocked' && step.evidence !== 'blocked by an earlier required step')
      blockedRecord.verification = { state: 'blocked', verifiedAt: report.verifiedAt, evidence: reportPath }
      blockedRecord.tests.supplyChain = { required: true, status: 'passed', evidence: report.steps.find((step) => step.id === 'supply-chain.review')?.evidence || 'typed Harness supply-chain review passed' }
      blockedRecord.tests.officialBaseline = { required: true, status: 'blocked', evidence: blocker?.evidence || 'typed Harness blocked' }
      blockedRecord.tests.lifecycle = { required: true, status: 'blocked', evidence: 'lifecycle steps did not run after the blocking required step' }
      blockedRecord.registry = { state: 'ineligible', reason: 'current-baseline-verification-blocked' }
      blockedReports.push({ recordPath: `intake/records/${name}`, record: blockedRecord })
      continue
    }
    if (report.status !== 'passed') {
      skipped.push({ id: record.id, reason: `report-${report.status}` })
      continue
    }
    const synchronized = synchronizeHarnessEvidence({
      record,
      report,
      plan,
      baseline,
      environment: {
        profile: report.profileBase?.template || report.classification.protocol,
        platform: report.execution?.workspace || 'ephemeral-harness',
        node: process.versions.node,
      },
    })
    prepared.push({
      recordPath: `intake/records/${name}`,
      evidencePath: evidenceFileForRecord(record),
      ...synchronized,
    })
  }

  for (const item of prepared) {
    await mkdir(resolve(root, 'intake/evidence'), { recursive: true })
    await writeFile(resolve(root, item.evidencePath), content(item.evidence))
    await writeFile(resolve(root, item.recordPath), content(item.record))
    const blocked = admissions.blocked.find((entry) => entry.id === item.record.submission.manifest.project.id)
    const state = exclusionState(item.record)
    if (blocked && state) Object.assign(blocked, state)
  }
  for (const item of blockedReports) await writeFile(resolve(root, item.recordPath), content(item.record))
  await writeFile(resolve(root, 'registry-admissions.json'), content(admissions))
  await buildIntakeQueue({ root })
  await buildFeeds({ root })
  return { synchronized: prepared.map((item) => item.record.id), blocked: blockedReports.map((item) => item.record.id), skipped }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncHarnessEvidence()
  console.log(`synchronized ${result.synchronized.length} passed Harness report(s); recorded ${result.blocked.length} blocked report(s); skipped ${result.skipped.length}`)
  for (const item of result.skipped) console.log(`- ${item.id}: ${item.reason}`)
}
