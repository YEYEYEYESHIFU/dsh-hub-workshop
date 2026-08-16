#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { selectVerificationReleaseIds } from './verification-selection-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}

async function git(...args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(stderr.trim() || `git ${args.join(' ')} failed`)))
  })
}

async function readCurrentRecords() {
  const directory = resolve(ROOT, 'intake/records')
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  return Promise.all(files.map((name) => readFile(resolve(directory, name), 'utf8').then(JSON.parse)))
}

async function previousRecord(commit, path) {
  try {
    return JSON.parse(await git('show', `${commit}:${path}`))
  } catch {
    return null
  }
}

const before = option('before')
const output = option('output')
if (!before || !/^[0-9a-f]{40}$/.test(before) || !output) {
  throw new Error('usage: node scripts/select-verification-releases.mjs --before COMMIT --output PATH')
}
const newHistory = /^0{40}$/.test(before)
const changedPaths = newHistory ? [] : (await git('diff', '--name-only', before, 'HEAD')).trim().split('\n').filter(Boolean)
const globalInputs = new Set([
  'official-baseline.json',
  'loader-adapters.json',
  'automation-policy.json',
  'scripts/typed-harness-lib.mjs',
  'scripts/automation-policy-lib.mjs',
])
const globalChanged = newHistory || changedPaths.some((path) => globalInputs.has(path))
let currentRecords = await readCurrentRecords()
let previousRecords = []
if (!globalChanged) {
  const changedRecordPaths = changedPaths.filter((path) => /^intake\/records\/[^/]+\.json$/.test(path))
  previousRecords = (await Promise.all(changedRecordPaths.map((path) => previousRecord(before, path)))).filter(Boolean)
  const changedNames = new Set(changedRecordPaths.map((path) => basename(path, '.json')))
  currentRecords = currentRecords.filter((record) => changedNames.has(record.id))
}
const releaseIds = selectVerificationReleaseIds({ currentRecords, previousRecords, globalChanged })
await writeFile(resolve(output), `${JSON.stringify(releaseIds, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `release_ids=${JSON.stringify(releaseIds)}\nselected_count=${releaseIds.length}\n`)
}
console.log(`selected ${releaseIds.length} release(s) for verification${globalChanged ? ' after a global Harness input changed' : ''}`)
