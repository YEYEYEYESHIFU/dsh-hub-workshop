#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { reviewDigest, validateRealProjectReview } from './real-project-review-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const index = JSON.parse(await readFile(resolve(ROOT, 'intake/real-project-review-index.json'), 'utf8'))
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
if (errors.length) throw new Error(errors.join('\n'))

console.log(`real-project reviews accepted: ${expected.projects} fixed cases, ${expected.typePlansReady} ready plans, ${expected.adaptersPassed} adapter passes, ${expected.admissions} admissions, ${expected.rc6Verified} RC.6 verified`)
