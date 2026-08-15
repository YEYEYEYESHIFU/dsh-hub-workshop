#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createMcpProcessAdapter, createRc6ProfileAdapter, createSkillStaticAdapter } from './harness-adapters.mjs'
import { FIXTURE_COMMIT, FIXTURE_PREVIOUS_COMMIT, FIXTURE_VERIFIED_AT, fixtureDefinition, fixtureSubmission } from './harness-fixtures.mjs'
import { createHarnessPlan, runHarnessPlan } from './typed-harness-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const baseline = JSON.parse(await readFile(resolve(ROOT, 'official-baseline.json'), 'utf8'))
const [kind] = process.argv.slice(2)
const keepWorkspace = process.argv.includes('--keep-workspace')

async function run(kindToRun, { emit = true } = {}) {
  const fixture = fixtureDefinition(kindToRun)
  const plan = createHarnessPlan(await fixtureSubmission(kindToRun), baseline)
  const options = { plan, sourceRoot: fixture.sourceRoot, sourceCommit: FIXTURE_COMMIT, fixtureSource: true, keepWorkspace }
  const adapter = kindToRun === 'profile'
    ? await createRc6ProfileAdapter({ ...options, previousSourceRoot: fixture.previousSourceRoot, previousSourceCommit: FIXTURE_PREVIOUS_COMMIT })
    : kindToRun === 'mcp'
      ? await createMcpProcessAdapter(options)
      : await createSkillStaticAdapter(options)
  const report = await runHarnessPlan(plan, adapter, {
    verifiedAt: FIXTURE_VERIFIED_AT,
    verifier: `local-${kindToRun}-adapter`,
  })
  if (emit) console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
  return report
}

if (!['profile', 'mcp', 'skill', 'all'].includes(kind || '')) {
  console.error('Usage: node scripts/run-harness-fixture.mjs profile|mcp|skill|all')
  process.exitCode = 2
} else if (kind === 'all') {
  const reports = []
  for (const current of ['skill', 'mcp', 'profile']) {
    const report = await run(current, { emit: false })
    reports.push(report)
    if (report.status !== 'passed') break
  }
  console.log(JSON.stringify(reports, null, 2))
} else {
  await run(kind)
}
