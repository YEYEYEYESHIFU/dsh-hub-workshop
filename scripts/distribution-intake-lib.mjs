import { createHash } from 'node:crypto'
import { componentLicenseInventory, validateLicenseExpression } from './license-lib.mjs'

const DISTRIBUTION_SCHEMA = 'omdsh-distribution/v1'
const COMMIT_RE = /^[0-9a-f]{40}$/
const REPOSITORY_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/
const BUILTIN_PRESETS = new Set(['code', 'cordis', 'minimal', 'standard'])
const PACKAGE_NAME_RE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const FIXED_GITHUB_SPEC_RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9a-f]{40})$/
const MAX_MANIFEST_BYTES = 128 * 1024

function requireCondition(condition, message, errors) {
  if (!condition) errors.push(message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, allowed, name, errors) {
  if (!object(value)) return
  const extras = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extras.length > 0) errors.push(`${name} has unexpected fields: ${extras.join(', ')}`)
}

function normalizedRepository(value) {
  return String(value || '').replace(/\/$/, '')
}

export function distributionManifestDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function validateDistributionManifest(value) {
  const errors = []
  requireCondition(object(value), 'distribution must be an object', errors)
  if (!object(value)) return errors
  exactKeys(value, ['$schema', 'schema', 'id', 'version', 'channel', 'title', 'summary', 'translations', 'maintainer', 'compatibility', 'agentPreset', 'useCases', 'items', 'application'], 'distribution', errors)
  requireCondition(value.schema === DISTRIBUTION_SCHEMA, 'unsupported distribution schema', errors)
  requireCondition(ID_RE.test(value.id || ''), 'distribution id is invalid', errors)
  requireCondition(SEMVER_RE.test(value.version || ''), 'distribution version is invalid', errors)
  requireCondition(['preview', 'stable'].includes(value.channel), 'distribution channel is invalid', errors)
  requireCondition(typeof value.title === 'string' && value.title.length > 0, 'distribution title is required', errors)
  requireCondition(typeof value.summary === 'string' && value.summary.length >= 12, 'distribution summary must contain at least 12 characters', errors)

  exactKeys(value.translations, ['en'], 'translations', errors)
  exactKeys(value.translations?.en, ['title', 'summary'], 'translations.en', errors)
  requireCondition(typeof value.translations?.en?.title === 'string' && value.translations.en.title.length > 0, 'English title is required', errors)
  requireCondition(typeof value.translations?.en?.summary === 'string' && value.translations.en.summary.length >= 12, 'English summary must contain at least 12 characters', errors)

  exactKeys(value.maintainer, ['name', 'url'], 'maintainer', errors)
  requireCondition(typeof value.maintainer?.name === 'string' && value.maintainer.name.length > 0, 'maintainer name is required', errors)
  try {
    const url = new URL(value.maintainer?.url)
    requireCondition(url.protocol === 'https:', 'maintainer URL must use HTTPS', errors)
  } catch {
    errors.push('maintainer URL is invalid')
  }

  exactKeys(value.compatibility, ['harness', 'declared'], 'compatibility', errors)
  requireCondition(value.compatibility?.harness === 'official-profile/v1', 'distribution must target official-profile/v1', errors)
  requireCondition(typeof value.compatibility?.declared === 'string' && value.compatibility.declared.length >= 12, 'declared compatibility must contain at least 12 characters', errors)

  exactKeys(value.agentPreset, ['mode', 'id'], 'agentPreset', errors)
  requireCondition(value.agentPreset?.mode === 'builtin' && BUILTIN_PRESETS.has(value.agentPreset?.id), 'distribution must reference a built-in Agent Preset', errors)

  requireCondition(Array.isArray(value.useCases) && value.useCases.length >= 1 && value.useCases.length <= 5, 'distribution must declare 1-5 use cases', errors)
  const useCaseIds = new Set()
  for (const [index, useCase] of (value.useCases || []).entries()) {
    exactKeys(useCase, ['id', 'title', 'translations'], `useCases[${index}]`, errors)
    requireCondition(ID_RE.test(useCase?.id || ''), `useCases[${index}].id is invalid`, errors)
    requireCondition(!useCaseIds.has(useCase?.id), `duplicate use case ${useCase?.id}`, errors)
    useCaseIds.add(useCase?.id)
    requireCondition(typeof useCase?.title === 'string' && useCase.title.length > 0, `useCases[${index}].title is required`, errors)
    exactKeys(useCase?.translations, ['en'], `useCases[${index}].translations`, errors)
    requireCondition(typeof useCase?.translations?.en === 'string' && useCase.translations.en.length > 0, `useCases[${index}].translations.en is required`, errors)
  }

  requireCondition(Array.isArray(value.items) && value.items.length > 0, 'distribution must contain at least one component', errors)
  const projectIds = new Set()
  for (const [index, item] of (value.items || []).entries()) {
    if (item?.type === 'source') {
      exactKeys(item, ['type', 'id', 'packageName', 'version', 'enabled', 'license', 'source', 'install'], `items[${index}]`, errors)
      requireCondition(ID_RE.test(item.id || ''), `items[${index}].id is invalid`, errors)
      requireCondition(PACKAGE_NAME_RE.test(item.packageName || ''), `items[${index}].packageName is invalid`, errors)
      requireCondition(SEMVER_RE.test(item.version || ''), `items[${index}].version is invalid`, errors)
      requireCondition(typeof item.enabled === 'boolean', `items[${index}].enabled must be boolean`, errors)
      exactKeys(item.license, ['expression', 'source'], `items[${index}].license`, errors)
      for (const licenseError of validateLicenseExpression(item.license?.expression)) errors.push(`items[${index}]: ${licenseError}`)
      requireCondition(['package-manifest', 'author-declared'].includes(item.license?.source), `items[${index}].license.source is invalid`, errors)
      exactKeys(item.source, ['repository', 'ref'], `items[${index}].source`, errors)
      requireCondition(REPOSITORY_RE.test(normalizedRepository(item.source?.repository)), `items[${index}].source.repository is invalid`, errors)
      requireCondition(COMMIT_RE.test(item.source?.ref || ''), `items[${index}].source.ref must be a full commit`, errors)
      exactKeys(item.install, ['mode', 'spec'], `items[${index}].install`, errors)
      const install = FIXED_GITHUB_SPEC_RE.exec(item.install?.spec || '')
      const source = REPOSITORY_RE.exec(normalizedRepository(item.source?.repository))
      requireCondition(item.install?.mode === 'profile-bundle', `items[${index}].install.mode is unsupported`, errors)
      requireCondition(install !== null, `items[${index}].install.spec must be a fixed GitHub commit`, errors)
      requireCondition(install !== null && source !== null
        && install[1].toLowerCase() === source[1].toLowerCase()
        && install[2].toLowerCase() === source[2].toLowerCase()
        && install[3] === item.source.ref, `items[${index}].install.spec must match its fixed source`, errors)
      requireCondition(!projectIds.has(item.id), `duplicate distribution component ${item.id}`, errors)
      projectIds.add(item.id)
      continue
    }
    exactKeys(item, ['type', 'projectId', 'releaseId', 'enabled'], `items[${index}]`, errors)
    requireCondition(item?.type === undefined || item.type === 'registry', `items[${index}].type is invalid`, errors)
    requireCondition(typeof item?.projectId === 'string' && item.projectId.length > 0, `items[${index}].projectId is required`, errors)
    requireCondition(typeof item?.releaseId === 'string' && item.releaseId.startsWith(`${item.projectId}@`), `items[${index}].releaseId must belong to its project`, errors)
    requireCondition(typeof item?.enabled === 'boolean', `items[${index}].enabled must be boolean`, errors)
    requireCondition(!projectIds.has(item?.projectId), `duplicate distribution component ${item?.projectId}`, errors)
    projectIds.add(item?.projectId)
  }

  exactKeys(value.application, ['candidate', 'confirmation', 'recovery', 'externalSideEffects'], 'application', errors)
  requireCondition(value.application?.candidate === 'required', 'candidate application must be required', errors)
  requireCondition(value.application?.confirmation === 'required', 'user confirmation must be required', errors)
  requireCondition(value.application?.recovery === 'managed-profile-generation', 'distribution recovery must use managed Profile generations', errors)
  requireCondition(value.application?.externalSideEffects === 'not-covered', 'external side effects must remain explicitly outside recovery', errors)
  return [...new Set(errors)]
}

export function validateDistributionComponents(manifest, registry) {
  const errors = []
  requireCondition(registry?.schema === 'omdsh-registry/v1', 'unsupported Registry schema', errors)
  const entries = new Map((registry?.entries || []).map((entry) => [entry.id, entry]))
  for (const item of manifest.items || []) {
    if (item.type === 'source') {
      errors.push(`${item.id}: fixed-source components are allowed in local Experimental Packs but must enter the Registry before trusted publication`)
      continue
    }
    const entry = entries.get(item.projectId)
    const release = entry?.releases?.find((candidate) => candidate.id === item.releaseId)
    requireCondition(release !== undefined, `${item.releaseId}: Release is not present in the current Registry`, errors)
    if (!release) continue
    requireCondition(release.state === undefined || release.state === 'active', `${item.releaseId}: Release is not active`, errors)
    requireCondition(release.install?.mode === 'profile-bundle', `${item.releaseId}: Distribution v1 supports only Profile Bundle Releases`, errors)
    requireCondition(release.management?.mode === undefined || release.management.mode === 'transactional', `${item.releaseId}: Release is not transactionally managed`, errors)
  }
  return errors
}

export function distributionLicenseInventory(manifest, registry) {
  return componentLicenseInventory(manifest, registry)
}

function issueField(body, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = String(body || '').match(new RegExp(`(?:^|\\n)###\\s+${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n###\\s|$)`, 'i'))
    if (match) {
      const value = match[1].trim()
      if (value && value !== '_No response_') return value
    }
  }
  return ''
}

export function extractDistributionIssueCoordinates(event) {
  const body = event?.issue?.body || ''
  const repository = normalizedRepository(issueField(body, ['维护仓库 / Maintainer repository', 'Maintainer repository']))
  const ref = issueField(body, ['完整 commit SHA / Full commit SHA', 'Full commit SHA'])
  const path = issueField(body, ['Manifest 路径 / Manifest path', 'Manifest path'])
  const compatibilityEvidence = issueField(body, ['兼容性与运行证据 / Compatibility and run evidence', 'Compatibility and run evidence'])
  const errors = []
  requireCondition(REPOSITORY_RE.test(repository), 'distribution repository must be a public GitHub repository URL', errors)
  requireCondition(COMMIT_RE.test(ref), 'distribution ref must be a full 40-character commit', errors)
  requireCondition(SAFE_PATH_RE.test(path), 'distribution manifest path is unsafe or is not JSON', errors)
  requireCondition(compatibilityEvidence.length > 0, 'distribution compatibility evidence is required', errors)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { repository, ref, path, compatibilityEvidence }
}

function requestHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'omdsh-workshop-distribution-intake',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function githubJson(url, { fetchImpl, token, description }) {
  const response = await fetchImpl(url, { headers: requestHeaders(token) })
  if (!response.ok) throw new Error(`${description} failed with GitHub HTTP ${response.status}`)
  return response.json()
}

export async function fetchFixedDistribution(coordinates, { fetchImpl = fetch, token = '' } = {}) {
  const repository = REPOSITORY_RE.exec(coordinates.repository)
  if (!repository) throw new Error('unsupported distribution repository URL')
  const [, owner, name] = repository
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const facts = await githubJson(apiBase, { fetchImpl, token, description: 'public repository lookup' })
  if (facts.private !== false) throw new Error('distribution repository must be public')
  if (facts.disabled === true || facts.archived === true) throw new Error('distribution repository is unavailable')
  const commit = await githubJson(`${apiBase}/git/commits/${coordinates.ref}`, { fetchImpl, token, description: 'fixed commit lookup' })
  if (commit.sha !== coordinates.ref) throw new Error('distribution commit did not resolve exactly')
  const encodedPath = coordinates.path.split('/').map(encodeURIComponent).join('/')
  const file = await githubJson(`${apiBase}/contents/${encodedPath}?ref=${coordinates.ref}`, { fetchImpl, token, description: 'fixed distribution manifest lookup' })
  if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('fixed distribution manifest is not a readable file')
  const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64')
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('distribution manifest exceeds 128 KiB')
  let manifest
  try { manifest = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('fixed distribution manifest is not valid JSON') }
  const errors = validateDistributionManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { manifest, bytes, repositoryFacts: facts }
}

export function createDistributionIntakeRecord({ coordinates, manifest, registry, issueNumber, compatibilityEvidence }) {
  const componentErrors = validateDistributionComponents(manifest, registry)
  if (componentErrors.length > 0) throw new Error(componentErrors.join('; '))
  return {
    schema: 'omdsh-distribution-intake/v1',
    id: `${manifest.id}@${manifest.version}`,
    source: { repository: coordinates.repository, ref: coordinates.ref, path: coordinates.path },
    manifest,
    submission: { issue: issueNumber, compatibilityEvidence },
    verification: {
      fixedSource: 'passed',
      components: 'passed',
      registrySnapshotId: registry.snapshotId,
    },
    review: { state: 'pending-review' },
    publication: { state: 'ineligible', reason: 'human-composition-review-required' },
  }
}
