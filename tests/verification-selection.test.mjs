import assert from 'node:assert/strict'
import test from 'node:test'

import { selectVerificationReleaseIds, verificationInput } from '../scripts/verification-selection-lib.mjs'

function record(id, ref = '1'.repeat(40)) {
  return {
    id,
    submission: { repository: 'https://github.com/example/plugin', ref, path: null, manifest: { schema: 'fixture' } },
    review: { state: 'pending-review' },
    verification: { state: 'untested' },
  }
}

test('selection ignores generated review and verification state changes', () => {
  const previous = record('plugin@1.0.0')
  const current = structuredClone(previous)
  current.review.state = 'approved'
  current.verification.state = 'current-baseline-passed'
  assert.equal(verificationInput(previous), verificationInput(current))
  assert.deepEqual(selectVerificationReleaseIds({ currentRecords: [current], previousRecords: [previous] }), [])
})

test('selection reruns added or changed immutable submission inputs', () => {
  const previous = record('plugin@1.0.0')
  const changed = record('plugin@1.0.0', '2'.repeat(40))
  const added = record('new-plugin@1.0.0')
  assert.deepEqual(selectVerificationReleaseIds({ currentRecords: [changed, added], previousRecords: [previous] }), [
    'new-plugin@1.0.0',
    'plugin@1.0.0',
  ])
})

test('global Harness inputs invalidate every current Intake release', () => {
  const current = [record('b@1.0.0'), record('a@1.0.0')]
  assert.deepEqual(selectVerificationReleaseIds({ currentRecords: current, previousRecords: current, globalChanged: true }), [
    'a@1.0.0',
    'b@1.0.0',
  ])
})
