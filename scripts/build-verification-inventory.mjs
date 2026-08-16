#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { githubRepository, validateExternalEvidence } from './external-evidence-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const [catalog, admissions, baseline, queue, topicSnapshot, externalEvidence] = await Promise.all([
  json('catalog.json'),
  json('registry-admissions.json'),
  json('official-baseline.json'),
  json('intake-queue.json'),
  json('topic-repositories.json'),
  json('external-evidence.json'),
])
const externalErrors = validateExternalEvidence(externalEvidence)
if (externalErrors.length) throw new Error(externalErrors.join('; '))
const baselineId = `${baseline.runtime.package}@${baseline.runtime.version}`
const blocked = new Map(admissions.blocked.map((record) => [record.id, record]))
const admitted = new Map(admissions.admissions.map((record) => [record.id, record]))
const intake = new Map(queue.records.map((record) => [record.submission.manifest.project.id, record]))
const topicByRepository = new Map(topicSnapshot.repositories.map((repository) => [`${repository.owner}/${repository.name}`.toLocaleLowerCase('en-US'), repository]))
const externalByRepository = new Map(externalEvidence.observations.map((observation) => [observation.repository.fullName.toLocaleLowerCase('en-US'), observation]))

const projects = catalog.packages.map((project) => {
  const blockedRecord = blocked.get(project.id)
  const admission = admitted.get(project.id)
  const intakeRecord = intake.get(project.id)
  const exactIntake = intakeRecord?.submission?.manifest?.release?.version === project.version ? intakeRecord : null
  const repository = githubRepository(project.repository)
  if (!repository) throw new Error(`${project.id}: invalid catalog repository identity`)
  const topic = topicByRepository.get(repository.key)
  const external = externalByRepository.get(repository.key)
  const requestedMode = admission?.mode || blockedRecord?.mode || 'guided'
  const management = requestedMode === 'profile-bundle'
    ? 'transactional'
    : requestedMode === 'repository-plugin'
      ? 'managed'
      : 'guided'
  return {
    id: project.id,
    repository: project.repository,
    ref: project.ref,
    path: project.repositoryPath || null,
    identity: {
      repositoryId: Number.isSafeInteger(topic?.repositoryId) ? topic.repositoryId : null,
      fullName: repository.fullName,
      repository: repository.url,
      path: project.repositoryPath || null,
    },
    management: exactIntake?.classification?.management || management,
    review: {
      state: exactIntake?.review?.state || (admission ? 'approved' : 'pending-review'),
      reason: exactIntake
        ? exactIntake.review?.notes || 'exact-intake-review-state'
        : admission ? 'registry-admitted' : 'dedicated-intake-not-completed',
    },
    verification: {
      baseline: baselineId,
      state: exactIntake?.verification?.state || (admission
        ? 'current-baseline-passed'
        : blockedRecord
          ? 'blocked'
          : 'untested'),
      reason: exactIntake?.verification?.evidence || (admission
        ? 'admission-evidence-accepted'
        : blockedRecord?.reason || 'no-current-baseline-evidence'),
    },
    registry: {
      state: exactIntake?.registry?.state || (admission ? 'admitted' : 'ineligible'),
    },
    externalEvidence: external ? [{
      provider: external.provider,
      scope: external.scope.type,
      status: external.probe.status,
      observedAt: external.observedAt,
      runtime: structuredClone(external.runtime),
      authority: external.authority,
      source: structuredClone(external.source),
    }] : [],
    capabilities: project.workshop,
  }
}).sort((left, right) => left.id.localeCompare(right.id))

function counts(field, nested) {
  const values = {}
  for (const project of projects) {
    const value = nested ? project[field][nested] : project[field]
    values[value] = (values[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))
}

function capabilityCounts(select) {
  const values = {}
  for (const project of projects) {
    const value = select(project.capabilities)
    values[value] = (values[value] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)))
}

const output = {
  schema: 'omdsh-workshop-verification-inventory/v1',
  generatedAt: new Date(Math.max(Date.parse(admissions.updatedAt), Date.parse(queue.generatedAt))).toISOString(),
  officialBaseline: {
    package: baseline.runtime.package,
    version: baseline.runtime.version,
    integrity: baseline.runtime.integrity,
    releaseChannel: baseline.runtime.releaseChannel,
    ga: baseline.runtime.ga,
  },
  policy: {
    catalogDoesNotGrantInstallAuthority: true,
    historicalEvidenceDoesNotSatisfyCurrentBaseline: true,
    unknownProjectsUseGuidedPublicHandling: true,
    externalEvidenceIsSupplemental: true,
    failClosed: true,
  },
  summary: {
    catalogProjects: projects.length,
    management: counts('management'),
    review: counts('review', 'state'),
    verification: counts('verification', 'state'),
    registry: counts('registry', 'state'),
    seamlessInstall: capabilityCounts((capabilities) => capabilities.install.seamless.state),
    failureIsolation: capabilityCounts((capabilities) => capabilities.install.failureIsolation.state),
    hotReload: capabilityCounts((capabilities) => capabilities.lifecycle.hotReload.state),
    integrationProtocols: capabilityCounts((capabilities) => capabilities.integration.protocol),
    admissionRoutes: capabilityCounts((capabilities) => capabilities.admission.route),
    externalEvidence: {
      matchedProjects: projects.filter((project) => project.externalEvidence.length > 0).length,
      reportedPass: projects.filter((project) => project.externalEvidence.some((evidence) => evidence.status === 'reported-pass')).length,
      reportedFail: projects.filter((project) => project.externalEvidence.some((evidence) => evidence.status === 'reported-fail')).length,
    },
  },
  projects,
}

const target = resolve(ROOT, 'verification-inventory.json')
const temporary = `${target}.tmp-${process.pid}`
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`)
await rename(temporary, target)
console.log(`built verification inventory: ${projects.length} projects, ${output.summary.verification['current-baseline-passed'] ?? 0} current-baseline verified`)
