import { createHash } from 'node:crypto'

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function repositoryKey(repository) {
  if (Number.isSafeInteger(repository.repositoryId) && repository.repositoryId > 0) return `github:${repository.repositoryId}`
  return `${repository.owner}/${repository.name}`.toLocaleLowerCase('en-US')
}

export function repositoryFingerprint(repository) {
  const facts = {
    repositoryId: Number.isSafeInteger(repository.repositoryId) ? repository.repositoryId : null,
    owner: repository.owner,
    name: repository.name,
    description: repository.description || '',
    defaultBranch: repository.defaultBranch || 'main',
    topics: [...(repository.topics || [])].sort(),
    archived: repository.archived === true,
    createdAt: repository.createdAt || null,
    commitUpdatedAt: repository.commitUpdatedAt || null,
    metadataUpdatedAt: repository.metadataUpdatedAt || null
  }
  return `sha256:${createHash('sha256').update(canonical(facts)).digest('hex')}`
}

export function buildTopicDelta(previous, current) {
  if (previous?.schema !== 'dsh-topic-discovery/v1' || current?.schema !== 'dsh-topic-discovery/v1') {
    throw new Error('Topic delta requires two dsh-topic-discovery/v1 snapshots')
  }
  if (previous.topic !== current.topic) throw new Error('Topic snapshots do not describe the same topic')
  const before = new Map(previous.repositories.map((repository) => [repositoryKey(repository), repository]))
  const after = new Map(current.repositories.map((repository) => [repositoryKey(repository), repository]))
  const changes = []
  for (const [key, repository] of after) {
    const old = before.get(key)
    const beforeFingerprint = old ? repositoryFingerprint(old) : null
    const afterFingerprint = repositoryFingerprint(repository)
    if (!old || beforeFingerprint !== afterFingerprint) {
      changes.push({
        repository: key,
        change: old ? 'updated' : 'added',
        beforeFingerprint,
        afterFingerprint
      })
    }
  }
  for (const [key, repository] of before) {
    if (!after.has(key)) {
      changes.push({
        repository: key,
        change: 'removed',
        beforeFingerprint: repositoryFingerprint(repository),
        afterFingerprint: null
      })
    }
  }
  changes.sort((left, right) => left.repository.localeCompare(right.repository))
  const counts = {
    previous: before.size,
    current: after.size,
    added: changes.filter((item) => item.change === 'added').length,
    updated: changes.filter((item) => item.change === 'updated').length,
    removed: changes.filter((item) => item.change === 'removed').length,
    unchanged: [...after.keys()].filter((key) => before.has(key)
      && repositoryFingerprint(before.get(key)) === repositoryFingerprint(after.get(key))).length
  }
  return {
    schema: 'omdsh-topic-delta/v1',
    topic: current.topic,
    previousGeneratedAt: previous.generatedAt,
    generatedAt: current.generatedAt,
    counts,
    changes
  }
}
