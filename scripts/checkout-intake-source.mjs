#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}

const releaseId = option('release')
const output = option('output')
const previousOutput = option('previous-output')
if (!releaseId || !output || !resolve(output).startsWith('/')) {
  throw new Error('usage: node scripts/checkout-intake-source.mjs --release ID --output /ABSOLUTE/PATH [--previous-output /ABSOLUTE/PATH]')
}
const record = JSON.parse(await readFile(resolve(ROOT, 'intake/records', `${releaseId}.json`), 'utf8'))

const environment = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/false',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

async function git(args) {
  return exec('git', args, { env: environment, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 })
}

async function checkout(repository, ref, destination) {
  await mkdir(destination, { recursive: true })
  if ((await readdir(destination)).length > 0) throw new Error(`checkout destination is not empty: ${destination}`)
  await git(['init', '--quiet', destination])
  await git(['-C', destination, 'remote', 'add', 'origin', repository])
  await git(['-c', 'http.version=HTTP/1.1', '-c', 'credential.helper=', '-C', destination, 'fetch', '--quiet', '--depth=1', 'origin', ref])
  await git(['-C', destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
  const { stdout: head } = await git(['-C', destination, 'rev-parse', 'HEAD'])
  if (head.trim() !== ref) throw new Error(`fixed checkout resolved ${head.trim()} instead of ${ref}`)
  const { stdout: status } = await git(['-C', destination, 'status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim()) throw new Error('fixed checkout is not clean')
}

const checkoutRoot = resolve(output)
await checkout(record.submission.repository, record.submission.ref, checkoutRoot)
const sourceRoot = record.submission.path
  ? join(checkoutRoot, record.submission.path.replace(/^\//, ''))
  : checkoutRoot
const outputs = { checkout_root: checkoutRoot, source_root: sourceRoot }

const updateFrom = record.submission.manifest.release.updateFrom
if (updateFrom) {
  if (!previousOutput || !resolve(previousOutput).startsWith('/')) throw new Error('--previous-output is required for an update release')
  const previousRoot = resolve(previousOutput)
  await checkout(record.submission.repository, updateFrom.ref, previousRoot)
  outputs.previous_checkout_root = previousRoot
  outputs.previous_source_root = record.submission.path
    ? join(previousRoot, record.submission.path.replace(/^\//, ''))
    : previousRoot
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''))
}
console.log(JSON.stringify(outputs, null, 2))
