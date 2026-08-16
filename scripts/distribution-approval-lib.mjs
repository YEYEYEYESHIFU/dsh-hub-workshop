import { distributionManifestDigest } from './distribution-intake-lib.mjs'

export function approveDistributionRecord({ record, reviewer, reviewedAt, notes = '' }) {
  if (typeof reviewer !== 'string' || reviewer.trim() === '') throw new Error('reviewer is required')
  if (typeof reviewedAt !== 'string' || new Date(reviewedAt).toISOString() !== reviewedAt) throw new Error('reviewedAt must be a normalized ISO timestamp')
  if (record.verification?.fixedSource !== 'passed' || record.verification?.components !== 'passed') throw new Error(`${record.id}: Distribution preflight did not pass`)
  const updatedRecord = structuredClone(record)
  updatedRecord.review = {
    state: 'approved',
    reviewer: reviewer.trim(),
    reviewedAt,
    ...(notes.trim() ? { notes: notes.trim() } : {}),
  }
  updatedRecord.publication = { state: 'admitted', reason: 'composition-approved-and-components-registry-bound' }
  const admission = {
    id: record.id,
    decision: 'admitted',
    source: structuredClone(record.source),
    manifestDigest: distributionManifestDigest(record.manifest),
    registrySnapshotId: record.verification.registrySnapshotId,
    approval: {
      reviewer: reviewer.trim(),
      reviewedAt,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    },
  }
  return { record: updatedRecord, admission }
}
