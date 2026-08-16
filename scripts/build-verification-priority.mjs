#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildVerificationPriority, validateVerificationPriority } from './verification-priority-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = (path) => readFile(resolve(ROOT, path), 'utf8').then(JSON.parse)
const [catalog, inventory, externalEvidence, topicSnapshot] = await Promise.all([
  json('catalog.json'),
  json('verification-inventory.json'),
  json('external-evidence.json'),
  json('topic-repositories.json'),
])
const output = buildVerificationPriority({ catalog, inventory, externalEvidence, topicSnapshot })
const errors = validateVerificationPriority(output)
if (errors.length) throw new Error(errors.join('; '))
const target = resolve(ROOT, 'verification-priority.json')
const temporary = `${target}.tmp-${process.pid}`
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`)
await rename(temporary, target)
console.log(`built verification priority: ${output.summary.matchedRepositories} matched, ${output.summary.externalOnlyRepositories} external-only`)
