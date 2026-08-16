#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDistributionComponents, validateDistributionManifest } from './distribution-intake-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')

async function json(path) {
  return JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
}

export async function buildDistributionIntakeQueue({ root = ROOT, write = true } = {}) {
  const directory = resolve(root, 'distribution-intake/records')
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  const records = await Promise.all(names.map((name) => readFile(resolve(directory, name), 'utf8').then(JSON.parse)))
  const registry = await readFile(resolve(root, 'registry-v1.json'), 'utf8').then(JSON.parse)
  const ids = new Set()
  for (const record of records) {
    if (record.schema !== 'omdsh-distribution-intake/v1') throw new Error(`${record.id}: unsupported Distribution intake record`)
    if (ids.has(record.id)) throw new Error(`${record.id}: duplicate Distribution intake record`)
    ids.add(record.id)
    if (!['pending-review', 'needs-fix', 'approved'].includes(record.review?.state)) throw new Error(`${record.id}: invalid review state`)
    if (!['ineligible', 'admitted'].includes(record.publication?.state)) throw new Error(`${record.id}: invalid publication state`)
    if (record.publication.state === 'admitted' && record.review.state !== 'approved') throw new Error(`${record.id}: publication requires approval`)
    if (record.id !== `${record.manifest?.id}@${record.manifest?.version}`) throw new Error(`${record.id}: Distribution record identity differs from its manifest`)
    if (record.verification?.registrySnapshotId !== registry.snapshotId) throw new Error(`${record.id}: Distribution record uses a stale Registry snapshot`)
    const errors = [...validateDistributionManifest(record.manifest), ...validateDistributionComponents(record.manifest, registry)]
    if (errors.length > 0) throw new Error(`${record.id}: ${errors.join('; ')}`)
  }
  const timestamps = records.map((record) => record.review?.reviewedAt).filter(Boolean).sort()
  const queue = {
    schema: 'omdsh-distribution-intake-queue/v1',
    generatedAt: timestamps.at(-1) || registry.generatedAt,
    registrySnapshotId: registry.snapshotId,
    policy: {
      componentsMustAlreadyBeRegistryInstallable: true,
      compositionCannotElevateAuthority: true,
      humanCompositionReviewRequired: true,
    },
    records,
  }
  if (write) await writeFile(resolve(root, 'distribution-intake-queue.json'), `${JSON.stringify(queue, null, 2)}\n`)
  return queue
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const queue = await buildDistributionIntakeQueue()
  console.log(`built Distribution intake queue: ${queue.records.length} record(s)`)
}
