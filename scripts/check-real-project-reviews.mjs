#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { reviewDigest, validateRealProjectReview } from './real-project-review-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const [index, queue] = await Promise.all([
  JSON.parse(await readFile(resolve(ROOT, 'intake/real-project-review-index.json'), 'utf8')),
  JSON.parse(await readFile(resolve(ROOT, 'intake-queue.json'), 'utf8')),
])
const errors = []
if (index.schema !== 'omdsh-workshop-real-project-review-index/v1') errors.push('unsupported real-project review index schema')
if (index.baseline !== '@deepseek-ai/dsh@0.1.0-rc.6') errors.push('real-project review index baseline is not exact RC.6')
if (index.policy?.sourceExecutionRequiresHumanTrust !== true || index.policy?.independentHumanReviewRequired !== true || index.policy?.admissionIsSeparate !== true) errors.push('real-project review gates are incomplete')

for (const item of index.records || []) {
  const review = JSON.parse(await readFile(resolve(ROOT, item.file), 'utf8'))
  errors.push(...validateRealProjectReview(review).map((error) => `${review.id}: ${error}`))
  if (reviewDigest(review) !== item.sha256) errors.push(`${review.id}: evidence digest mismatch`)
  if (item.rc6Verified !== false || item.admission === 'admitted' || item.humanReview === 'approved') errors.push(`${review.id}: generated pre-admission review grants authority`)
}

const facts = index.records || []
const expected = {
  projects: facts.length,
  fixedSources: facts.filter((item) => item.fixedSource === 'passed').length,
  typePlansReady: facts.filter((item) => item.typePlan === 'ready').length,
  adaptersPassed: facts.filter((item) => item.adapter === 'passed').length,
  humanReviewsApproved: facts.filter((item) => item.humanReview === 'approved').length,
  admissions: facts.filter((item) => item.admission === 'admitted').length,
  rc6Verified: facts.filter((item) => item.rc6Verified).length,
}
if (JSON.stringify(index.summary) !== JSON.stringify(expected)) errors.push('real-project review summary is stale')
const harness = {
  passed: queue.records.filter((item) => ['current-baseline-passed', 'source-evidence-passed'].includes(item.verification.state)).length,
  currentBaselinePassed: queue.records.filter((item) => item.verification.state === 'current-baseline-passed').length,
  guidedEvidencePassed: queue.records.filter((item) => item.verification.state === 'source-evidence-passed').length,
  blocked: queue.records.filter((item) => item.verification.state === 'blocked').length,
  admissions: queue.records.filter((item) => item.registry.state === 'admitted').length,
}
if (queue.records.length !== expected.projects) errors.push('real-project review index and typed Harness queue differ in project count')
if (errors.length) throw new Error(errors.join('\n'))

console.log(`pre-admission reviews accepted: ${expected.projects} fixed cases, ${expected.typePlansReady} ready plans; typed Harness: ${harness.passed} passed (${harness.currentBaselinePassed} RC.6 lifecycle, ${harness.guidedEvidencePassed} guided protocol), ${harness.blocked} blocked, ${harness.admissions} admitted`)
