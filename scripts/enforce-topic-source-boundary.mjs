#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isRetiredRepositoryOwner } from './topic-admission-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const snapshotPath = resolve(ROOT, 'topic-repositories.json')
const discoveryPath = resolve(ROOT, 'public-discovery.json')
const [snapshot, discovery] = await Promise.all([
  readFile(snapshotPath, 'utf8').then(JSON.parse),
  readFile(discoveryPath, 'utf8').then(JSON.parse),
])
const before = snapshot.repositories.length
snapshot.repositories = snapshot.repositories.filter((repository) => !isRetiredRepositoryOwner(repository))
snapshot.observedRepositoryCount = snapshot.repositories.length
snapshot.collection = {
  ...(snapshot.collection || {}),
  retiredOwnerExclusionsApplied: true,
  excludedRepositoryCount: Number(snapshot.collection?.excludedRepositoryCount || 0) + before - snapshot.repositories.length,
}
delete snapshot.collection.retiredOwnerExclusions
discovery.topic.observedRepositoryCount = snapshot.repositories.length
discovery.topic.collection = snapshot.collection

await Promise.all([
  writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`),
  writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`),
])
console.log(`enforced Topic source boundary: ${snapshot.repositories.length} retained, ${before - snapshot.repositories.length} retired-owner repositories removed`)
