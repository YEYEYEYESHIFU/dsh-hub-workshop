import assert from 'node:assert/strict'
import test from 'node:test'

import { importAwesomeRadarSnapshot, validateExternalEvidence } from '../scripts/external-evidence-lib.mjs'
import { buildVerificationPriority, validateVerificationPriority } from '../scripts/verification-priority-lib.mjs'

const provider = {
  id: 'radar-fixture',
  repository: 'https://github.com/example/radar',
  method: { kind: 'agent-smoke', isolation: 'provider-reported', runtimeSelection: 'latest-at-observation' },
}
const sourceCommit = 'a'.repeat(40)

function imported(entries) {
  const snapshot = {
    schema: 'radar-snapshot/2',
    generated_at: '2026-08-15T00:00:00.000Z',
    verdict: { total: entries.length },
    catalog_entries: entries,
  }
  const artifactBytes = Buffer.from(JSON.stringify(snapshot))
  return importAwesomeRadarSnapshot({
    provider,
    snapshot,
    sourceCommit,
    artifactPath: 'data/snapshots/fixture.json',
    artifactBytes,
  })
}

test('external Radar import pins provenance without granting Hub authority', () => {
  const evidence = imported([
    { name: 'Plugin', url: 'https://github.com/Example/Plugin', verdict: '✅ reported pass' },
    { name: 'Plugin duplicate', url: 'https://github.com/example/plugin', verdict: '❌ reported fail' },
    { name: 'Search result', url: 'https://github.com/search?q=dsh', verdict: '✅ reported pass' },
  ])
  assert.equal(evidence.summary.rawEntries, 3)
  assert.equal(evidence.summary.observations, 1)
  assert.equal(evidence.summary.rejected, 1)
  assert.equal(evidence.summary.duplicateRepositoryRows, 1)
  assert.equal(evidence.observations[0].probe.status, 'inconclusive')
  assert.deepEqual(evidence.observations[0].source.entryIndexes, [0, 1])
  assert.equal(evidence.observations[0].runtime.version, null)
  assert.equal(evidence.policy.grantsVerification, false)
  assert.equal(evidence.policy.grantsAdmission, false)
  assert.equal(evidence.policy.grantsInstallAuthority, false)
  assert.deepEqual(validateExternalEvidence(evidence), [])
})

test('priority queue uses external observations only as deterministic scheduling hints', () => {
  const externalEvidence = imported([
    { name: 'Matched', url: 'https://github.com/example/matched', verdict: '✅ reported pass' },
    { name: 'External only', url: 'https://github.com/example/external-only', verdict: '❌ reported fail' },
  ])
  const catalog = { packages: [{ id: 'matched', repository: 'https://github.com/example/matched', ref: 'b'.repeat(40) }] }
  const inventory = {
    generatedAt: '2026-08-15T01:00:00.000Z',
    projects: [{
      id: 'matched', path: null, management: 'transactional',
      review: { state: 'pending-review' },
      verification: { state: 'blocked' },
      registry: { state: 'ineligible' },
      capabilities: { admission: { state: 'needs-package-manifest' } },
    }],
  }
  const topicSnapshot = { repositories: [{ owner: 'example', name: 'matched', repositoryId: 42 }] }
  const priority = buildVerificationPriority({ catalog, inventory, externalEvidence, topicSnapshot })
  assert.equal(priority.queue[0].score, 115)
  assert.equal(priority.queue[0].priority, 'urgent')
  assert.equal(priority.queue[0].nextAction, 'resolve-local-blocker')
  assert.equal(priority.queue[0].identity.repositoryId, 42)
  assert.equal(priority.externalCandidates.length, 1)
  assert.equal(priority.externalCandidates[0].authority, 'none-until-intake-and-admission')
  assert.equal(priority.policy.priorityDoesNotGrantAdmission, true)
  assert.deepEqual(validateVerificationPriority(priority), [])
})

test('external evidence validation rejects authority escalation', () => {
  const evidence = imported([{ name: 'Plugin', url: 'https://github.com/example/plugin', verdict: '✅ reported pass' }])
  evidence.policy.grantsAdmission = true
  evidence.observations[0].authority = 'admitted'
  assert.match(validateExternalEvidence(evidence).join('; '), /must not grant Admission/)
  assert.match(validateExternalEvidence(evidence).join('; '), /authority must remain supplemental/)
})
