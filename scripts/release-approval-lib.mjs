import { createHash } from 'node:crypto'

import { applyEvidence } from './intake-lib.mjs'
import { harnessReportToEvidence, validateHarnessReport } from './typed-harness-lib.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function reportFileForRecord(record) {
  const suffix = record.classification.management === 'transactional' ? 'profile' : 'preflight'
  return `intake/reports/${record.id}.${suffix}.json`
}

export function planFileForRecord(record) {
  return `intake/plans/${record.id}.json`
}

export function evidenceFileForRecord(record) {
  return `intake/evidence/${record.id}.json`
}

function pinnedGithubSpec(record) {
  const url = new URL(record.submission.repository)
  assert(url.hostname === 'github.com', `${record.id}: admission requires a GitHub source`)
  const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(repository), `${record.id}: unsupported GitHub repository coordinates`)
  return `github:${repository}#${record.submission.ref}`
}

export function synchronizeHarnessEvidence({ record, report, plan, baseline, environment = {} }) {
  const reportErrors = validateHarnessReport(report, plan)
  assert(reportErrors.length === 0, `${record.id}: invalid Harness report: ${reportErrors.join('; ')}`)
  assert(report.status === 'passed', `${record.id}: Harness report status is ${report.status}`)
  const evidence = harnessReportToEvidence({ record, report, baseline, environment })
  const updatedRecord = applyEvidence(record, evidence, baseline)
  return { record: updatedRecord, evidence }
}

export function approveVerifiedRelease({
  record,
  report,
  plan,
  baseline,
  reviewer,
  reviewedAt,
  notes = '',
  riskLevel = 'unknown',
  reportBytes,
  environment = {},
}) {
  assert(typeof reviewer === 'string' && reviewer.trim() !== '', 'reviewer is required')
  assert(typeof reviewedAt === 'string' && new Date(reviewedAt).toISOString() === reviewedAt, 'reviewedAt must be a normalized ISO timestamp')
  assert(['unknown', 'low', 'medium', 'high', 'critical'].includes(riskLevel), 'unsupported risk level')

  const reviewedRecord = structuredClone(record)
  reviewedRecord.review = {
    state: 'approved',
    reviewer: reviewer.trim(),
    reviewedAt,
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  }
  const synchronized = synchronizeHarnessEvidence({ record: reviewedRecord, report, plan, baseline, environment })
  if (synchronized.record.classification.management === 'guided') {
    return { ...synchronized, admission: null }
  }
  assert(synchronized.record.classification.management === 'transactional', `${record.id}: only Profile Bundle admission is currently supported`)
  assert(synchronized.record.registry.state === 'eligible', `${record.id}: release did not become Registry-eligible`)

  const manifest = synchronized.record.submission.manifest
  const packageManifest = manifest.packageManifest
  const permissions = new Set(packageManifest.permissions || [])
  synchronized.record.registry = { state: 'admitted', reason: 'approved-and-current-baseline-verified' }
  const admission = {
    id: manifest.project.id,
    decision: 'admitted',
    mode: 'profile-bundle',
    source: {
      repository: synchronized.record.submission.repository,
      ref: synchronized.record.submission.ref,
      path: synchronized.record.submission.path,
    },
    version: manifest.release.version,
    packageName: manifest.release.profileBundle.packageName,
    spec: pinnedGithubSpec(synchronized.record),
    risk: {
      level: riskLevel,
      vulnerabilityScan: 'unknown',
      permissions: 'reviewed',
      nativeCode: permissions.has('native-code:none') ? 'absent' : 'unknown',
      installScripts: 'unknown',
      trustedPublisher: manifest.declarations.trustedPublisherRequested ? 'requested' : 'unknown',
    },
    approval: {
      reviewer: reviewer.trim(),
      reviewedAt,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    },
    evidence: {
      path: reportFileForRecord(synchronized.record),
      plan: planFileForRecord(synchronized.record),
      sha256: sha256(reportBytes),
    },
  }
  return { ...synchronized, admission }
}
