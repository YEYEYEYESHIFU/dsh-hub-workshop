#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateRecord } from './intake-lib.mjs'
import { validateHarnessPlan } from './typed-harness-lib.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function recordFiles(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => resolve(directory, entry.name))
    .sort()
}

export function validateHarnessPlanBindings(records, plans, baseline) {
  const errors = []
  const planByRelease = new Map()
  for (const plan of plans) {
    errors.push(...validateHarnessPlan(plan).map((error) => `${plan.releaseId || plan.id}: ${error}`))
    if (planByRelease.has(plan.releaseId)) errors.push(`${plan.releaseId}: duplicate typed Harness plan`)
    planByRelease.set(plan.releaseId, plan)
    if (`${plan.baseline?.package}@${plan.baseline?.version}` !== `${baseline.runtime.package}@${baseline.runtime.version}`
      || plan.baseline?.integrity !== baseline.runtime.integrity) {
      errors.push(`${plan.releaseId}: typed Harness plan baseline is stale`)
    }
  }
  const recordsById = new Map(records.map((record) => [record.id, record]))
  for (const record of records) {
    const plan = planByRelease.get(record.id)
    if (record.submission.manifest.schema === 'omdsh-workshop-submission/v2' && !plan) {
      errors.push(`${record.id}: v2 Intake record requires a typed Harness plan`)
      continue
    }
    if (!plan) continue
    if (plan.projectId !== record.submission.manifest.project.id
      || plan.source.repository !== record.submission.repository
      || plan.source.ref !== record.submission.ref
      || (plan.source.path ?? null) !== (record.submission.path ?? null)) {
      errors.push(`${record.id}: typed Harness plan source does not match the Intake record`)
    }
  }
  for (const plan of plans) {
    if (!recordsById.has(plan.releaseId)) errors.push(`${plan.releaseId}: orphan typed Harness plan`)
  }
  return [...new Set(errors)]
}

export async function buildIntakeQueue({ root = DEFAULT_ROOT, write = true } = {}) {
  const baseline = await json(resolve(root, 'official-baseline.json'))
  const [files, planFiles] = await Promise.all([
    recordFiles(resolve(root, 'intake/records')),
    recordFiles(resolve(root, 'intake/plans')),
  ])
  const [records, plans] = await Promise.all([
    Promise.all(files.map(json)),
    Promise.all(planFiles.map(json)),
  ])
  records.sort((left, right) => left.id.localeCompare(right.id))
  plans.sort((left, right) => left.releaseId.localeCompare(right.releaseId))
  const errors = [
    ...records.flatMap((record) => evaluateRecord(record, baseline)),
    ...validateHarnessPlanBindings(records, plans, baseline),
  ]
  const ids = new Set()
  for (const record of records) {
    if (ids.has(record.id)) errors.push(`${record.id}: duplicate intake record`)
    ids.add(record.id)
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const timestamps = records.flatMap((record) => [record.review?.reviewedAt, record.verification?.verifiedAt]).filter(Boolean)
  const queue = {
    schema: 'omdsh-workshop-intake-queue/v1',
    generatedAt: timestamps.sort().at(-1) || baseline.checkedAt,
    officialBaseline: `${baseline.runtime.package}@${baseline.runtime.version}`,
    policy: {
      managementModes: ['transactional', 'managed', 'guided'],
      reviewStateIsIndependent: true,
      registryEligibleModes: ['transactional', 'managed'],
      failClosed: true,
    },
    records,
  }
  if (write) await writeFile(resolve(root, 'intake-queue.json'), `${JSON.stringify(queue, null, 2)}\n`)
  return queue
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const queue = await buildIntakeQueue()
  console.log(`built intake queue: ${queue.records.length} record(s), baseline ${queue.officialBaseline}`)
}
