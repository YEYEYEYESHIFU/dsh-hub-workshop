#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHarnessPlan, harnessReportToEvidence } from './typed-harness-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const [command, firstPath, secondPath, thirdPath] = process.argv.slice(2)
const json = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'))
const baseline = JSON.parse(await readFile(resolve(ROOT, 'official-baseline.json'), 'utf8'))

function usage() {
  console.error('Usage: node scripts/harness.mjs plan <submission.json> | evidence <record.json> <report.json> [environment.json]')
  process.exitCode = 2
}

if (command === 'plan' && firstPath) {
  console.log(JSON.stringify(createHarnessPlan(await json(firstPath), baseline), null, 2))
} else if (command === 'evidence' && firstPath && secondPath) {
  const environment = thirdPath ? await json(thirdPath) : {}
  console.log(JSON.stringify(harnessReportToEvidence({
    record: await json(firstPath),
    report: await json(secondPath),
    baseline,
    environment,
  }), null, 2))
} else {
  usage()
}
