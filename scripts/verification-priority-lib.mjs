import { githubRepository } from './external-evidence-lib.mjs'

export const VERIFICATION_PRIORITY_SCHEMA = 'omdsh-verification-priority/v1'

function externalScore(status) {
  if (status === 'reported-pass') return 50
  if (status === 'reported-fail') return 45
  if (status === 'inconclusive') return 25
  if (status === 'not-run') return 10
  return 0
}

function managementScore(management) {
  if (management === 'transactional') return 30
  if (management === 'managed') return 20
  return 0
}

function priorityLevel(score) {
  if (score >= 90) return 'urgent'
  if (score >= 65) return 'high'
  if (score >= 35) return 'normal'
  return 'backlog'
}

function nextAction(project, observation) {
  if (project.registry?.state === 'admitted') return 'monitor-release'
  if (project.verification?.state === 'current-baseline-passed') return 'admission-review'
  if (project.verification?.state === 'blocked') return 'resolve-local-blocker'
  if (project.capabilities?.admission?.state !== 'needs-package-manifest') return 'deep-verify'
  if (observation?.probe?.status === 'reported-fail') return 'external-failure-triage'
  if (observation?.probe?.status === 'inconclusive') return 'probe-retry'
  return 'fixed-release-intake'
}

function observationProjection(observation) {
  if (!observation) return null
  return {
    provider: observation.provider,
    scope: observation.scope.type,
    status: observation.probe.status,
    observedAt: observation.observedAt,
    runtime: structuredClone(observation.runtime),
    authority: observation.authority,
    source: structuredClone(observation.source),
  }
}

export function buildVerificationPriority({ catalog, inventory, externalEvidence, topicSnapshot }) {
  if (externalEvidence?.policy?.grantsVerification !== false || externalEvidence?.policy?.grantsAdmission !== false) {
    throw new Error('verification priority requires supplemental-only external evidence')
  }
  const inventoryById = new Map(inventory.projects.map((project) => [project.id, project]))
  const externalByRepository = new Map(externalEvidence.observations.map((observation) => [observation.repository.fullName.toLocaleLowerCase('en-US'), observation]))
  const topicByRepository = new Map(topicSnapshot.repositories.map((repository) => [`${repository.owner}/${repository.name}`.toLocaleLowerCase('en-US'), repository]))
  const representedRepositories = new Set()

  const queue = catalog.packages.map((catalogProject) => {
    const project = inventoryById.get(catalogProject.id)
    if (!project) throw new Error(`${catalogProject.id}: verification inventory record is missing`)
    const repository = githubRepository(catalogProject.repository)
    if (!repository) throw new Error(`${catalogProject.id}: catalog repository is invalid`)
    representedRepositories.add(repository.key)
    const observation = externalByRepository.get(repository.key)
    const topic = topicByRepository.get(repository.key)
    const score = externalScore(observation?.probe?.status)
      + managementScore(project.management)
      + (project.verification?.state === 'blocked' ? 20 : 0)
      + (/^[0-9a-f]{40}$/.test(catalogProject.ref || '') ? 10 : 0)
      + (project.review?.state === 'pending-review' ? 5 : 0)
    return {
      projectId: project.id,
      identity: {
        repositoryId: Number.isSafeInteger(topic?.repositoryId) ? topic.repositoryId : null,
        fullName: repository.fullName,
        repository: repository.url,
        path: project.path ?? null,
        packageName: project.capabilities?.install?.packageName ?? null,
      },
      score,
      priority: priorityLevel(score),
      nextAction: nextAction(project, observation),
      local: {
        management: project.management,
        review: project.review.state,
        verification: project.verification.state,
        registry: project.registry.state,
      },
      externalEvidence: observationProjection(observation),
      authority: 'none-until-admission',
    }
  }).sort((left, right) => right.score - left.score || left.projectId.localeCompare(right.projectId))

  const externalCandidates = externalEvidence.observations
    .filter((observation) => !representedRepositories.has(observation.repository.fullName.toLocaleLowerCase('en-US')))
    .map((observation) => ({
      identity: structuredClone(observation.repository),
      score: externalScore(observation.probe.status),
      priority: priorityLevel(externalScore(observation.probe.status)),
      nextAction: 'static-discovery-review',
      externalEvidence: observationProjection(observation),
      authority: 'none-until-intake-and-admission',
    }))
    .sort((left, right) => right.score - left.score || left.identity.fullName.localeCompare(right.identity.fullName))

  const count = (values, field) => Object.fromEntries([...new Set(values.map((value) => value[field]))]
    .sort().map((value) => [value, values.filter((entry) => entry[field] === value).length]))
  return {
    $schema: './verification-priority.schema.json',
    schema: VERIFICATION_PRIORITY_SCHEMA,
    generatedAt: [inventory.generatedAt, externalEvidence.generatedAt].sort().at(-1),
    policy: {
      externalEvidenceIsSupplemental: true,
      priorityDoesNotGrantVerification: true,
      priorityDoesNotGrantAdmission: true,
      exactReleaseRequiredBeforeExecution: true,
    },
    summary: {
      catalogProjects: queue.length,
      catalogRepositories: representedRepositories.size,
      externalObservations: externalEvidence.observations.length,
      externalOnlyRepositories: externalCandidates.length,
      matchedRepositories: [...representedRepositories].filter((repository) => externalByRepository.has(repository)).length,
      priorities: count(queue, 'priority'),
      actions: count(queue, 'nextAction'),
    },
    queue,
    externalCandidates,
  }
}

export function validateVerificationPriority(document) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(document?.schema === VERIFICATION_PRIORITY_SCHEMA, 'unsupported verification priority schema')
  require(document?.policy?.externalEvidenceIsSupplemental === true, 'external evidence must stay supplemental')
  require(document?.policy?.priorityDoesNotGrantVerification === true, 'priority must not grant verification')
  require(document?.policy?.priorityDoesNotGrantAdmission === true, 'priority must not grant Admission')
  require(document?.summary?.catalogProjects === document?.queue?.length, 'priority queue count mismatch')
  require(document?.summary?.externalOnlyRepositories === document?.externalCandidates?.length, 'external-only priority count mismatch')
  require(document?.summary?.externalObservations === document?.summary?.matchedRepositories + document?.summary?.externalOnlyRepositories, 'external observation partition mismatch')
  require(new Set((document?.queue || []).map((entry) => entry.projectId)).size === document?.queue?.length, 'priority project IDs must be unique')
  require(document?.summary?.catalogRepositories === new Set((document?.queue || []).map((entry) => entry.identity?.fullName?.toLocaleLowerCase('en-US'))).size, 'priority repository count mismatch')
  require(document?.summary?.matchedRepositories === new Set((document?.queue || []).filter((entry) => entry.externalEvidence).map((entry) => entry.identity?.fullName?.toLocaleLowerCase('en-US'))).size, 'priority matched repository count mismatch')
  const sorted = (entries, identity) => entries.every((entry, index) => index === 0
    || entries[index - 1].score > entry.score
    || entries[index - 1].score === entry.score && identity(entries[index - 1]).localeCompare(identity(entry)) <= 0)
  require(sorted(document?.queue || [], (entry) => entry.projectId), 'priority queue must be deterministically sorted')
  require(sorted(document?.externalCandidates || [], (entry) => entry.identity.fullName), 'external candidates must be deterministically sorted')
  const values = document?.queue || []
  const counts = (field) => Object.fromEntries([...new Set(values.map((entry) => entry[field]))].sort()
    .map((value) => [value, values.filter((entry) => entry[field] === value).length]))
  require(JSON.stringify(document?.summary?.priorities) === JSON.stringify(counts('priority')), 'priority level counts mismatch')
  require(JSON.stringify(document?.summary?.actions) === JSON.stringify(counts('nextAction')), 'priority action counts mismatch')
  for (const entry of document?.queue || []) {
    require(entry.authority === 'none-until-admission', `${entry.projectId}: priority entry cannot carry authority`)
    require(entry.externalEvidence === null || entry.externalEvidence?.authority === 'supplemental-only', 'priority external evidence authority is invalid')
    require(entry.priority === priorityLevel(entry.score), `${entry.projectId}: priority level does not match score`)
  }
  for (const entry of document?.externalCandidates || []) {
    require(entry.authority === 'none-until-intake-and-admission', `${entry.identity?.fullName}: external candidate cannot carry authority`)
    require(entry.externalEvidence?.authority === 'supplemental-only', 'external candidate evidence authority is invalid')
    require(entry.priority === priorityLevel(entry.score), `${entry.identity?.fullName}: external priority level does not match score`)
    require(entry.nextAction === 'static-discovery-review', `${entry.identity?.fullName}: external candidate action is invalid`)
  }
  return [...new Set(errors)]
}
