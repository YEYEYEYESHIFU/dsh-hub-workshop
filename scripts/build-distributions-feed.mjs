#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  distributionLicenseInventory,
  distributionManifestDigest,
  validateDistributionComponents,
  validateDistributionManifest,
} from './distribution-intake-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (root, path) => JSON.parse(await readFile(resolve(root, path), 'utf8'))

function registryBinding(registry) {
  return { schema: registry.schema, snapshotId: registry.snapshotId, revision: registry.revision, origins: registry.origins }
}

function release(record, admission, baseline, registry) {
  const manifest = record.manifest
  return {
    id: record.id,
    version: manifest.version,
    channel: manifest.channel,
    compatibility: manifest.compatibility,
    agentPreset: manifest.agentPreset,
    useCases: manifest.useCases,
    items: manifest.items,
    licenses: distributionLicenseInventory(manifest, registry),
    application: manifest.application,
    source: record.source,
    resolution: {
      registrySnapshotId: admission.registrySnapshotId,
      runtime: {
        package: baseline.runtime.package,
        version: baseline.runtime.version,
        integrity: baseline.runtime.integrity,
      },
      format: 'omdsh-profile-pack/v1',
      signedEnvelope: 'omdsh-profile-pack-envelope/v1',
    },
    provenance: {
      manifestDigest: admission.manifestDigest,
      reviewer: admission.approval.reviewer,
      reviewedAt: admission.approval.reviewedAt,
    },
  }
}

export async function buildDistributionsFeed({ root = ROOT, write = true } = {}) {
  const [registry, queue, admissions, baseline] = await Promise.all([
    json(root, 'registry-v1.json'),
    json(root, 'distribution-intake-queue.json'),
    json(root, 'distribution-admissions.json'),
    json(root, 'official-baseline.json'),
  ])
  if (registry.schema !== 'omdsh-registry/v1') throw new Error('unsupported Registry schema')
  if (queue.schema !== 'omdsh-distribution-intake-queue/v1') throw new Error('unsupported Distribution intake queue')
  if (admissions.schema !== 'omdsh-distribution-admissions/v1') throw new Error('unsupported Distribution admissions')
  const records = new Map(queue.records.map((record) => [record.id, record]))
  const releases = []
  const admissionIds = new Set()
  for (const admission of admissions.admissions) {
    if (admissionIds.has(admission.id)) throw new Error(`${admission.id}: duplicate Distribution admission`)
    admissionIds.add(admission.id)
    const record = records.get(admission.id)
    if (!record) throw new Error(`${admission.id}: missing Distribution intake record`)
    if (admission.decision !== 'admitted' || record.review?.state !== 'approved' || record.publication?.state !== 'admitted') throw new Error(`${admission.id}: Distribution is not approved`)
    if (JSON.stringify(admission.source) !== JSON.stringify(record.source)) throw new Error(`${admission.id}: source differs from Intake`)
    if (admission.manifestDigest !== distributionManifestDigest(record.manifest)) throw new Error(`${admission.id}: manifest digest mismatch`)
    if (admission.registrySnapshotId !== registry.snapshotId || record.verification.registrySnapshotId !== registry.snapshotId) throw new Error(`${admission.id}: Registry snapshot is stale`)
    const manifestErrors = validateDistributionManifest(record.manifest)
    const componentErrors = validateDistributionComponents(record.manifest, registry)
    if (manifestErrors.length + componentErrors.length > 0) throw new Error(`${admission.id}: ${[...manifestErrors, ...componentErrors].join('; ')}`)
    releases.push({ record, admission, value: release(record, admission, baseline, registry) })
  }
  const byId = new Map()
  for (const item of releases) {
    const manifest = item.record.manifest
    const project = byId.get(manifest.id) || {
      id: manifest.id,
      title: manifest.title,
      summary: manifest.summary,
      translations: manifest.translations,
      maintainer: manifest.maintainer,
      latestRelease: item.record.id,
      releases: [],
    }
    project.releases.push(item.value)
    project.releases.sort((left, right) => Date.parse(right.provenance.reviewedAt) - Date.parse(left.provenance.reviewedAt))
    project.latestRelease = project.releases[0].id
    byId.set(manifest.id, project)
  }
  const output = {
    schema: 'omdsh-distributions/v1',
    generatedAt: admissions.updatedAt,
    registry: registryBinding(registry),
    policy: {
      installAuthority: 'omdsh-registry/v1',
      componentAuthority: 'never-elevated-by-composition',
      application: 'candidate-and-confirm',
      externalSideEffects: 'not-covered',
    },
    distributions: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
  if (write) await writeFile(resolve(root, 'distributions-v1.json'), `${JSON.stringify(output, null, 2)}\n`)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildDistributionsFeed()
  console.log(`built Distributions feed: ${output.distributions.length} distribution(s)`)
}
