import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateAdmission } from '../scripts/build-install-feeds.mjs'
import { approveVerifiedRelease, sha256 } from '../scripts/release-approval-lib.mjs'

const json = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))

test('one explicit review projects passed RC6 evidence into a Profile admission', async () => {
  const [record, report, plan, baseline, catalog] = await Promise.all([
    json('../intake/records/7d7d@0.4.0-rc.2.json'),
    json('../intake/reports/7d7d@0.4.0-rc.2.profile.json'),
    json('../intake/plans/7d7d@0.4.0-rc.2.json'),
    json('../official-baseline.json'),
    json('../catalog.json'),
  ])
  const reportBytes = await readFile(new URL('../intake/reports/7d7d@0.4.0-rc.2.profile.json', import.meta.url))
  const result = approveVerifiedRelease({
    record,
    report,
    plan,
    baseline,
    reviewer: 'synthetic-reviewer',
    reviewedAt: '2026-08-15T00:00:00.000Z',
    notes: 'Exact release reviewed in a unit test.',
    riskLevel: 'unknown',
    reportBytes,
  })
  assert.equal(result.record.review.state, 'approved')
  assert.equal(result.record.registry.state, 'admitted')
  assert.equal(result.admission.evidence.sha256, sha256(reportBytes))
  assert.match(result.admission.spec, /^github:omdsh-dev\/7d7d#[0-9a-f]{40}$/)
  assert.equal(validateAdmission(
    result.admission,
    catalog.packages.find((item) => item.id === '7d7d'),
    report,
    sha256(reportBytes),
    `${baseline.runtime.package}@${baseline.runtime.version}`,
    plan,
    result.record,
  ), true)
})
