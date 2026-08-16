#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildAutomationPlan } from './automation-policy-lib.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}

const ROOT = resolve(import.meta.dirname, '..')
const json = (path) => readFile(resolve(ROOT, path), 'utf8').then(JSON.parse)
const [queue, baseline, policy, loaderRegistry] = await Promise.all([
  json('intake-queue.json'),
  json('official-baseline.json'),
  json('automation-policy.json'),
  json('loader-adapters.json')
])
const releasesFile = option('releases-file')
if (option('release') && releasesFile) throw new Error('use either --release or --releases-file')
const releaseSelection = releasesFile
  ? await readFile(resolve(releasesFile), 'utf8').then(JSON.parse)
  : option('release')
const plan = buildAutomationPlan(queue.records, baseline, policy, loaderRegistry, releaseSelection)
const output = option('output')
if (output) await writeFile(resolve(output), `${JSON.stringify(plan, null, 2)}\n`)
const staticJobs = plan.jobs.filter((job) => !job.requiresTrust)
const trustedJobs = plan.jobs.filter((job) => job.requiresTrust)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `static_matrix=${JSON.stringify({ include: staticJobs })}`,
    `trusted_matrix=${JSON.stringify({ include: trustedJobs })}`,
    `static_count=${staticJobs.length}`,
    `trusted_count=${trustedJobs.length}`,
    `admission_eligible=${plan.summary.admissionEligible}`,
    `release_ids=${JSON.stringify(plan.releaseIds)}`,
    `selected_count=${plan.summary.releases}`,
    `blocked_count=${plan.blocked.length}`
  ].map((line) => `${line}\n`).join(''))
}
console.log(JSON.stringify(plan, null, 2))
if (plan.blocked.length > 0) process.exitCode = 2
