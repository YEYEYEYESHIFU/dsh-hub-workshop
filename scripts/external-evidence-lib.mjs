import { createHash } from 'node:crypto'

export const EXTERNAL_EVIDENCE_SCHEMA = 'omdsh-supplemental-evidence/v1'
export const EXTERNAL_EVIDENCE_AUTHORITY = 'supplemental-only'

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const RESTRICTED_OWNER = ['dsh', 'external'].join('-')

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function githubRepository(value) {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || parts.length !== 2 || parts[0] === 'search') return null
    if (!parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) return null
    const fullName = `${parts[0]}/${parts[1]}`
    return { fullName, key: fullName.toLocaleLowerCase('en-US'), url: `https://github.com/${fullName}` }
  } catch {
    return null
  }
}

export function normalizeProbeStatus(value) {
  const verdict = String(value || '').trim()
  if (verdict.startsWith('✅')) return 'reported-pass'
  if (verdict.startsWith('❌')) return 'reported-fail'
  if (verdict.startsWith('⏳')) return 'not-run'
  return 'inconclusive'
}

function normalizedTimestamp(value, name) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.valueOf())) throw new Error(`${name} must be a timestamp`)
  return date.toISOString()
}

function isNormalizedTimestamp(value) {
  const date = new Date(value)
  return typeof value === 'string' && !Number.isNaN(date.valueOf()) && date.toISOString() === value
}

function providerRecord(provider, sourceCommit, artifactPath, artifactDigest, snapshot) {
  return {
    id: provider.id,
    repository: provider.repository,
    sourceCommit,
    artifact: { path: artifactPath, digest: artifactDigest },
    method: {
      kind: provider.method?.kind || 'agent-smoke',
      isolation: provider.method?.isolation || 'provider-reported',
      runtimeSelection: provider.method?.runtimeSelection || 'latest-at-observation',
      reproducibility: 'external-artifact-only',
    },
    reportedCounts: structuredClone(snapshot.verdict || null),
    authority: EXTERNAL_EVIDENCE_AUTHORITY,
  }
}

export function importAwesomeRadarSnapshot({ provider, snapshot, sourceCommit, artifactPath, artifactBytes }) {
  if (!provider?.id || !githubRepository(provider.repository)) throw new Error('external provider identity is invalid')
  if (!FULL_COMMIT_RE.test(sourceCommit || '')) throw new Error('external provider source must use a full commit')
  if (snapshot?.schema !== 'radar-snapshot/2' || !Array.isArray(snapshot.catalog_entries)) {
    throw new Error('unsupported awesome-dsh-plugins snapshot')
  }
  const observedAt = normalizedTimestamp(snapshot.generated_at, 'snapshot.generated_at')
  const digest = sha256(artifactBytes)
  const byRepository = new Map()
  const rejected = []

  for (const [entryIndex, entry] of snapshot.catalog_entries.entries()) {
    const repository = githubRepository(entry?.url)
    if (!repository) {
      rejected.push({ entryIndex, name: String(entry?.name || '').slice(0, 200), reason: 'unresolved-repository-url' })
      continue
    }
    if (repository.fullName.split('/')[0].toLocaleLowerCase('en-US') === RESTRICTED_OWNER) {
      rejected.push({ entryIndex, name: String(entry?.name || '').slice(0, 200), reason: 'restricted-owner' })
      continue
    }
    const probe = {
      status: normalizeProbeStatus(entry.verdict),
      rawVerdict: String(entry.verdict || '').slice(0, 200),
      reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim().slice(0, 1000) : null,
    }
    const existing = byRepository.get(repository.key)
    if (existing) {
      existing.source.entryIndexes.push(entryIndex)
      existing.probe.rawVerdicts = [...new Set([...(existing.probe.rawVerdicts || [existing.probe.rawVerdict]), probe.rawVerdict])]
      delete existing.probe.rawVerdict
      if (existing.probe.status !== probe.status) existing.probe.status = 'inconclusive'
      existing.probe.reason = existing.probe.reason || probe.reason
      continue
    }
    byRepository.set(repository.key, {
      id: `${provider.id}:${repository.key}`,
      provider: provider.id,
      repository: { id: null, fullName: repository.fullName, url: repository.url },
      scope: { type: 'repository', path: null, packageName: null },
      observedAt,
      runtime: { package: '@deepseek-ai/dsh', version: null, channel: 'latest-at-observation' },
      probe,
      authority: EXTERNAL_EVIDENCE_AUTHORITY,
      source: { providerCommit: sourceCommit, artifactPath, artifactDigest: digest, entryIndexes: [entryIndex] },
    })
  }

  const observations = [...byRepository.values()].sort((left, right) => left.repository.fullName.localeCompare(right.repository.fullName))
  const statuses = {}
  for (const observation of observations) statuses[observation.probe.status] = (statuses[observation.probe.status] || 0) + 1
  const output = {
    $schema: './external-evidence.schema.json',
    schema: EXTERNAL_EVIDENCE_SCHEMA,
    generatedAt: observedAt,
    policy: {
      purpose: 'candidate-prioritization-and-independent-corroboration',
      grantsVerification: false,
      grantsAdmission: false,
      grantsInstallAuthority: false,
      exactReleaseRequiredForDeepVerification: true,
    },
    providers: [providerRecord(provider, sourceCommit, artifactPath, digest, snapshot)],
    summary: {
      rawEntries: snapshot.catalog_entries.length,
      observations: observations.length,
      rejected: rejected.length,
      duplicateRepositoryRows: snapshot.catalog_entries.length - observations.length - rejected.length,
      statuses,
    },
    observations,
    rejected,
  }
  const errors = validateExternalEvidence(output)
  if (errors.length) throw new Error(errors.join('; '))
  return output
}

export function validateExternalEvidence(document) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(document?.schema === EXTERNAL_EVIDENCE_SCHEMA, 'unsupported external evidence schema')
  require(document?.policy?.grantsVerification === false, 'external evidence must not grant verification')
  require(document?.policy?.grantsAdmission === false, 'external evidence must not grant Admission')
  require(document?.policy?.grantsInstallAuthority === false, 'external evidence must not grant installation authority')
  require(Array.isArray(document?.providers) && document.providers.length > 0, 'external evidence requires a provider')
  require(Array.isArray(document?.observations), 'external evidence observations must be an array')
  require(isNormalizedTimestamp(document?.generatedAt), 'external evidence timestamp is invalid')
  const providerIds = new Set()
  const providers = new Map()
  for (const provider of document?.providers || []) {
    require(!providerIds.has(provider.id), `duplicate external provider ${provider.id}`)
    providerIds.add(provider.id)
    providers.set(provider.id, provider)
    require(githubRepository(provider.repository) !== null, `${provider.id}: provider repository is invalid`)
    require(FULL_COMMIT_RE.test(provider.sourceCommit || ''), `${provider.id}: provider commit must be exact`)
    require(DIGEST_RE.test(provider.artifact?.digest || ''), `${provider.id}: artifact digest is invalid`)
    require(typeof provider.artifact?.path === 'string' && provider.artifact.path.length > 0 && !provider.artifact.path.split('/').includes('..'), `${provider.id}: artifact path is invalid`)
    require(provider.authority === EXTERNAL_EVIDENCE_AUTHORITY, `${provider.id}: provider authority must remain supplemental`)
  }
  const repositories = new Set()
  const statuses = {}
  for (const observation of document?.observations || []) {
    const repository = githubRepository(observation.repository?.url)
    require(repository !== null && repository.fullName === observation.repository?.fullName, `${observation.id}: repository identity is invalid`)
    require(!repositories.has(repository?.key), `${observation.id}: duplicate repository observation`)
    if (repository) repositories.add(repository.key)
    require(providerIds.has(observation.provider), `${observation.id}: provider is unknown`)
    require(['reported-pass', 'reported-fail', 'inconclusive', 'not-run'].includes(observation.probe?.status), `${observation.id}: probe status is invalid`)
    statuses[observation.probe?.status] = (statuses[observation.probe?.status] || 0) + 1
    require(observation.authority === EXTERNAL_EVIDENCE_AUTHORITY, `${observation.id}: observation authority must remain supplemental`)
    require(observation.runtime?.package === '@deepseek-ai/dsh', `${observation.id}: runtime package is invalid`)
    require(observation.runtime?.version === null, `${observation.id}: provider did not prove an exact runtime version`)
    require(DIGEST_RE.test(observation.source?.artifactDigest || ''), `${observation.id}: source digest is invalid`)
    const provider = providers.get(observation.provider)
    require(observation.source?.providerCommit === provider?.sourceCommit, `${observation.id}: provider commit binding mismatch`)
    require(observation.source?.artifactPath === provider?.artifact?.path, `${observation.id}: artifact path binding mismatch`)
    require(observation.source?.artifactDigest === provider?.artifact?.digest, `${observation.id}: artifact digest binding mismatch`)
    require(Array.isArray(observation.source?.entryIndexes) && observation.source.entryIndexes.length > 0, `${observation.id}: source rows are required`)
  }
  require(document?.summary?.observations === document?.observations?.length, 'external evidence observation count mismatch')
  require(document?.summary?.rejected === document?.rejected?.length, 'external evidence rejected count mismatch')
  require(document?.summary?.rawEntries === document?.summary?.observations + document?.summary?.rejected + document?.summary?.duplicateRepositoryRows, 'external evidence raw count mismatch')
  for (const status of ['reported-pass', 'reported-fail', 'inconclusive', 'not-run']) {
    require((document?.summary?.statuses?.[status] || 0) === (statuses[status] || 0), `external evidence ${status} count mismatch`)
  }
  return [...new Set(errors)]
}
