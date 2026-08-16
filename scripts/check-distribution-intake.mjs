#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { buildDistributionIntakeQueue } from './build-distribution-intake-queue.mjs'
import { buildDistributionsFeed } from './build-distributions-feed.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const [queue, feed, admissions, registry] = await Promise.all([
  json('distribution-intake-queue.json'),
  json('distributions-v1.json'),
  json('distribution-admissions.json'),
  json('registry-v1.json'),
])
const [generatedQueue, generatedFeed] = await Promise.all([
  buildDistributionIntakeQueue({ root: ROOT, write: false }),
  buildDistributionsFeed({ root: ROOT, write: false }),
])
const errors = []
if (JSON.stringify(queue) !== JSON.stringify(generatedQueue)) errors.push('distribution-intake-queue.json is stale; run npm run distribution:intake:build')
if (JSON.stringify(feed) !== JSON.stringify(generatedFeed)) errors.push('distributions-v1.json is stale; run npm run distributions:build')
if (queue.registrySnapshotId !== registry.snapshotId || feed.registry?.snapshotId !== registry.snapshotId) errors.push('Distribution artifacts must bind the current Registry snapshot')
const admitted = new Set(admissions.admissions.map((item) => item.id))
const published = new Set(feed.distributions.flatMap((item) => item.releases.map((release) => release.id)))
if (admitted.size !== published.size || [...admitted].some((id) => !published.has(id))) errors.push('Distribution admissions and public feed must match exactly')
if (errors.length > 0) throw new Error(errors.join('\n'))

console.log(`Distribution intake accepted: ${queue.records.length} queued, ${admitted.size} admitted, Registry ${registry.snapshotId}`)
