#!/usr/bin/env node

import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildTopicDelta } from './topic-delta-lib.mjs'

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}

const previousPath = option('previous')
const currentPath = option('current') || 'topic-repositories.json'
const outputPath = option('output')
if (!previousPath) throw new Error('usage: node scripts/topic-delta.mjs --previous FILE [--current FILE] [--output FILE]')

const [previous, current] = await Promise.all([
  readFile(resolve(previousPath), 'utf8').then(JSON.parse),
  readFile(resolve(currentPath), 'utf8').then(JSON.parse)
])
const delta = buildTopicDelta(previous, current)
if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify(delta, null, 2)}\n`)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, [
    `changed=${delta.changes.length > 0}`,
    `added=${delta.counts.added}`,
    `updated=${delta.counts.updated}`,
    `removed=${delta.counts.removed}`
  ].map((line) => `${line}\n`).join(''))
}
console.log(JSON.stringify(delta.counts))
