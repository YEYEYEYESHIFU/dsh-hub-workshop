import { readFile } from 'node:fs/promises'
import { validateWorkshopManifest } from './workshop-manifest-lib.mjs'

export const MANAGEMENT_MODES = Object.freeze(['transactional', 'managed', 'guided'])
export const REVIEW_STATES = Object.freeze(['pending-review', 'needs-fix', 'blocked', 'approved'])
export const VERIFICATION_STATES = Object.freeze(['untested', 'source-evidence-passed', 'current-baseline-passed', 'blocked', 'failed'])

const COMMIT_RE = /^[0-9a-f]{40}$/
const REPOSITORY_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/
const REPOSITORY_SOURCE_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#([0-9a-f]{40})&path:\/(.+\/)?\.dsh-plugin$/
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const EXACT_SPEC_RE = /^(?:(?:v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|(?:git\+https:\/\/|https:\/\/|github:)[^#\s]+#[0-9a-f]{40})$/
const GUIDED_COMMAND_RE = /(?:^|\n)\s*(?:[$>]\s*)?(?:npm|pnpm|yarn|npx|bun|curl|wget|bash|sh|powershell|dsh|dsh-sdk|omdsh)(?:\s|$)/i
const SECRET_RE = /(?:github_pat_|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b)/i

function requireCondition(condition, message, errors) {
  if (!condition) errors.push(message)
}

function normalizedRepository(value) {
  return String(value || '').replace(/\/$/, '')
}

function safePath(value) {
  return value === null || (typeof value === 'string' && value.startsWith('/') && !value.split('/').includes('..'))
}

export function managementMode(method) {
  if (method === 'profile-bundle') return 'transactional'
  if (['repository-plugin', 'loader-adapter'].includes(method)) return 'managed'
  if (method === 'guided') return 'guided'
  return null
}

export function validateSubmission(manifest) {
  const errors = []
  requireCondition(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'submission must be an object', errors)
  if (errors.length > 0) return errors
  requireCondition(['omdsh-workshop-submission/v1', 'omdsh-workshop-submission/v2'].includes(manifest.schema), 'unsupported submission schema', errors)
  requireCondition(['create-project', 'add-release'].includes(manifest.operation), 'unsupported submission operation', errors)
  requireCondition(!SECRET_RE.test(JSON.stringify(manifest)), 'submission appears to contain a credential or private key', errors)

  const project = manifest.project || {}
  const release = manifest.release || {}
  const management = manifest.management || {}
  const declarations = manifest.declarations || {}
  const packageManifest = manifest.packageManifest
  if (manifest.schema === 'omdsh-workshop-submission/v2') {
    errors.push(...validateWorkshopManifest(packageManifest))
  }
  requireCondition(/^[a-z0-9][a-z0-9-]*$/.test(project.id || ''), 'invalid project id', errors)
  requireCondition(REPOSITORY_RE.test(project.repository || ''), 'repository must be a public GitHub repository URL', errors)
  requireCondition(safePath(project.path ?? null), 'project path must be null or a safe absolute repository path', errors)
  requireCondition(COMMIT_RE.test(release.ref || ''), 'release ref must be a full 40-character commit', errors)
  requireCondition(typeof release.version === 'string' && release.version.length > 0, 'release version is required', errors)
  requireCondition(typeof release.compatibility === 'string' && release.compatibility.length > 0, 'declared compatibility is required', errors)
  requireCondition(declarations.installScriptsMustRemainDisabled === true, 'install scripts must remain disabled during intake', errors)
  requireCondition(typeof declarations.permissions === 'string' && declarations.permissions.length > 0, 'permission declaration is required', errors)
  requireCondition(typeof declarations.testing === 'string' && declarations.testing.length > 0, 'testing declaration is required', errors)

  const mode = managementMode(management.method)
  requireCondition(mode !== null, 'management method must be profile-bundle, repository-plugin, loader-adapter, or guided', errors)
  requireCondition(typeof management.instructions === 'string' && management.instructions.length > 0, 'integration instructions are required', errors)

  if (mode === 'transactional') {
    requireCondition(management.protocol === 'harness-profile', 'transactional intake must use harness-profile', errors)
    requireCondition(management.source === null, 'transactional intake must not declare a Repository Plugin source', errors)
    requireCondition(PACKAGE_RE.test(release.profileBundle?.packageName || ''), 'transactional intake requires a valid Profile Bundle package name', errors)
    requireCondition(EXACT_SPEC_RE.test(release.profileBundle?.spec || ''), 'transactional intake requires an exact package spec', errors)
    if (String(release.profileBundle?.spec || '').includes('#')) {
      requireCondition(release.profileBundle.spec.endsWith(`#${release.ref}`), 'Profile Bundle spec must pin the submitted commit', errors)
    }
    if (manifest.schema === 'omdsh-workshop-submission/v2') {
      if (manifest.operation === 'add-release') {
        requireCondition(typeof release.updateFrom?.version === 'string' && release.updateFrom.version.length > 0, 'transactional add-release requires a previous release version for update testing', errors)
        requireCondition(COMMIT_RE.test(release.updateFrom?.ref || ''), 'transactional add-release requires a fixed previous release commit', errors)
        requireCondition(release.updateFrom?.ref !== release.ref, 'previous release commit must differ from the submitted release', errors)
        requireCondition(release.updateFrom?.version !== release.version, 'previous release version must differ from the submitted release', errors)
      } else {
        requireCondition(release.updateFrom === null, 'initial transactional release must set updateFrom to null', errors)
      }
    }
  }
  if (management.method === 'repository-plugin') {
    requireCondition(management.protocol === 'harness-repository', 'managed intake must use harness-repository', errors)
    requireCondition(release.profileBundle === null, 'managed intake cannot declare a Profile Bundle', errors)
    const source = REPOSITORY_SOURCE_RE.exec(management.source || '')
    requireCondition(source !== null, 'managed intake source must pin a .dsh-plugin directory', errors)
    if (source) requireCondition(source[1] === release.ref, 'Repository Plugin source must pin the submitted commit', errors)
    requireCondition(String(management.instructions || '').includes(String(management.source || '')), 'managed instructions must contain the pinned source', errors)
    if (manifest.schema === 'omdsh-workshop-submission/v2') {
      if (manifest.operation === 'add-release') {
        requireCondition(typeof release.updateFrom?.version === 'string' && release.updateFrom.version.length > 0, 'managed add-release requires a previous release version for update testing', errors)
        requireCondition(COMMIT_RE.test(release.updateFrom?.ref || ''), 'managed add-release requires a fixed previous release commit', errors)
        requireCondition(release.updateFrom?.ref !== release.ref, 'previous release commit must differ from the submitted release', errors)
        requireCondition(release.updateFrom?.version !== release.version, 'previous release version must differ from the submitted release', errors)
      } else {
        requireCondition(release.updateFrom === null, 'initial managed release must set updateFrom to null', errors)
      }
    }
  }
  if (management.method === 'loader-adapter') {
    const builtInProtocols = new Set(['harness-profile', 'harness-repository', 'harness-cordis', 'mcp', 'skill', 'third-party'])
    const builtInAdapters = new Set(['profile-bundle', 'repository-plugin', 'mcp-server', 'skill', 'third-party'])
    requireCondition(!builtInProtocols.has(management.protocol), 'loader-adapter intake requires a namespaced custom protocol', errors)
    requireCondition(!builtInAdapters.has(packageManifest?.install?.adapter), 'loader-adapter intake requires a custom adapter id', errors)
    requireCondition(release.profileBundle === null, 'loader-adapter intake cannot declare a Profile Bundle', errors)
    requireCondition(management.source === null, 'loader-adapter intake resolves source through the fixed release and trusted Adapter Registry', errors)
    requireCondition(!GUIDED_COMMAND_RE.test(management.instructions || ''), 'loader-adapter intake must not expose an executable install command', errors)
    if (manifest.schema === 'omdsh-workshop-submission/v2') {
      if (manifest.operation === 'add-release') {
        requireCondition(typeof release.updateFrom?.version === 'string' && release.updateFrom.version.length > 0, 'loader-adapter add-release requires a previous release version for update testing', errors)
        requireCondition(COMMIT_RE.test(release.updateFrom?.ref || ''), 'loader-adapter add-release requires a fixed previous release commit', errors)
        requireCondition(release.updateFrom?.ref !== release.ref, 'previous release commit must differ from the submitted release', errors)
        requireCondition(release.updateFrom?.version !== release.version, 'previous release version must differ from the submitted release', errors)
      } else {
        requireCondition(release.updateFrom === null, 'initial loader-adapter release must set updateFrom to null', errors)
      }
    }
  }
  if (mode === 'guided') {
    requireCondition(['harness-cordis', 'mcp', 'skill', 'third-party'].includes(management.protocol), 'guided intake must declare harness-cordis, MCP, Skill, or third-party protocol', errors)
    requireCondition(release.profileBundle === null, 'guided intake cannot declare a Profile Bundle', errors)
    requireCondition(management.source === null, 'guided intake cannot expose executable install source', errors)
    requireCondition(!GUIDED_COMMAND_RE.test(management.instructions || ''), 'guided intake must not expose an executable install command', errors)
    if (manifest.schema === 'omdsh-workshop-submission/v2') requireCondition(release.updateFrom === null, 'guided v2 intake cannot claim an executable update source', errors)
  }
  if (manifest.schema === 'omdsh-workshop-submission/v2' && packageManifest && typeof packageManifest === 'object') {
    requireCondition(packageManifest.integration?.protocol === management.protocol, 'package manifest protocol must match submission management protocol', errors)
    requireCondition(packageManifest.lifecycle?.activation !== 'hot-reload' || release.capabilities?.restartRequired === false, 'hot-reload submission cannot require restart', errors)
    requireCondition(packageManifest.lifecycle?.activation === 'hot-reload'
      || release.capabilities?.restartRequired === /^restart-/.test(packageManifest.lifecycle?.activation || ''), 'restartRequired must match package lifecycle activation', errors)
  }
  return errors
}

function test(required, status, evidence) {
  return { required, status, ...(evidence ? { evidence } : {}) }
}

export function createIntakeRecord(manifest, baseline) {
  const errors = validateSubmission(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const mode = managementMode(manifest.management.method)
  const unavailableManagedContract = manifest.management.method === 'repository-plugin' && baseline.contracts.repositoryPlugin.status !== 'available'
  return {
    schema: 'omdsh-workshop-intake/v1',
    id: `${manifest.project.id}@${manifest.release.version}`,
    submission: {
      repository: normalizedRepository(manifest.project.repository),
      ref: manifest.release.ref,
      path: manifest.project.path ?? null,
      manifest,
    },
    classification: { management: mode },
    baseline: {
      package: baseline.runtime.package,
      version: baseline.runtime.version,
      integrity: baseline.runtime.integrity,
    },
    review: { state: 'pending-review' },
    verification: {
      state: unavailableManagedContract ? 'blocked' : 'untested',
      ...(unavailableManagedContract ? { evidence: `${baseline.contracts.repositoryPlugin.package}: ${baseline.contracts.repositoryPlugin.registryResult}` } : {}),
    },
    tests: {
      static: test(true, 'passed', 'submission manifest validation'),
      supplyChain: test(true, 'pending'),
      officialBaseline: mode === 'guided'
        ? test(false, 'not-applicable', 'guided entries expose no executable install intent')
        : unavailableManagedContract
          ? test(true, 'blocked', `${baseline.contracts.repositoryPlugin.package}: ${baseline.contracts.repositoryPlugin.registryResult}`)
          : test(true, 'pending'),
      lifecycle: mode === 'guided'
        ? test(false, 'not-applicable', 'guided entries have no Workshop-owned lifecycle')
        : test(true, unavailableManagedContract ? 'blocked' : 'pending'),
    },
    registry: {
      state: 'ineligible',
      reason: mode === 'guided'
        ? 'guided-catalog-only'
        : unavailableManagedContract
          ? 'official-repository-plugin-unavailable'
          : 'current-baseline-verification-required',
    },
  }
}

function sourceMatches(record, evidence) {
  return normalizedRepository(evidence.source?.repository) === record.submission.repository
    && evidence.source?.ref === record.submission.ref
    && (evidence.source?.path ?? null) === (record.submission.path ?? null)
}

function passed(check) {
  return check?.status === 'passed'
}

function notApplicable(check) {
  return check?.status === 'not-applicable'
}

export function applyEvidence(record, evidence, baseline) {
  const errors = []
  const mode = record.classification.management
  requireCondition(['omdsh-workshop-intake-evidence/v1', 'omdsh-workshop-intake-evidence/v2'].includes(evidence?.schema), 'unsupported evidence schema', errors)
  if (record.submission.manifest.schema === 'omdsh-workshop-submission/v2') {
    requireCondition(evidence?.schema === 'omdsh-workshop-intake-evidence/v2', 'v2 submission requires typed Harness v2 evidence', errors)
  }
  requireCondition(evidence?.projectId === record.submission.manifest.project.id, 'evidence project does not match submission', errors)
  requireCondition(evidence?.releaseId === record.id, 'evidence release does not match submission', errors)
  requireCondition(evidence?.management === mode, 'evidence management mode does not match intake', errors)
  requireCondition(sourceMatches(record, evidence || {}), 'evidence source coordinates do not match submission', errors)
  for (const name of ['static', 'manifest', 'entry', 'dshContract', 'compatibility', 'permissions', 'supplyChain']) {
    requireCondition(passed(evidence?.checks?.[name]), `${name} check must pass`, errors)
  }

  if (mode === 'guided') {
    requireCondition(evidence.runtime === null, 'guided evidence cannot claim an official runtime install', errors)
    requireCondition(evidence.capability === null, 'guided evidence cannot claim a runtime capability invocation', errors)
    for (const name of ['install', 'ready', 'functional', 'update', 'disable', 'remove', 'recovery']) {
      requireCondition(notApplicable(evidence?.checks?.[name]), `guided ${name} check must be not-applicable`, errors)
    }
    if (evidence?.schema === 'omdsh-workshop-intake-evidence/v2') {
      requireCondition(notApplicable(evidence?.checks?.failureIsolation), 'guided failureIsolation check must be not-applicable', errors)
      requireCondition(notApplicable(evidence?.checks?.hotReload), 'guided hotReload check must be not-applicable', errors)
    }
  } else {
    requireCondition(`${evidence?.runtime?.package}@${evidence?.runtime?.version}` === `${baseline.runtime.package}@${baseline.runtime.version}`, 'evidence does not use the current official runtime', errors)
    requireCondition(evidence?.runtime?.integrity === baseline.runtime.integrity, 'evidence runtime integrity does not match the official baseline', errors)
    if (record.submission.manifest.management.method === 'repository-plugin') {
      requireCondition(baseline.contracts.repositoryPlugin.status === 'available', 'official Repository Plugin contract is unavailable', errors)
    }
    requireCondition(evidence?.capability && typeof evidence.capability === 'object', `${mode} verification must identify a target capability`, errors)
    requireCondition(evidence?.capability?.assertion === 'registered-invoked-and-observed', `${mode} capability must be registered, invoked, and observed`, errors)
    for (const field of ['id', 'kind', 'invocation', 'expected', 'observed']) {
      requireCondition(typeof evidence?.capability?.[field] === 'string' && evidence.capability[field].length > 0, `${mode} capability ${field} is required`, errors)
    }
    for (const name of ['install', 'ready', 'functional', 'disable', 'remove', 'recovery']) {
      requireCondition(passed(evidence?.checks?.[name]), `${mode} ${name} check must pass`, errors)
    }
    const initialRelease = record.submission.manifest.operation === 'create-project'
      && record.submission.manifest.release.updateFrom === null
    requireCondition(initialRelease ? notApplicable(evidence?.checks?.update) : passed(evidence?.checks?.update), `${mode} update check does not match the release operation`, errors)
    if (evidence?.schema === 'omdsh-workshop-intake-evidence/v2') {
      requireCondition(passed(evidence?.checks?.failureIsolation), `${mode} failureIsolation check must pass`, errors)
      const hotReloadDeclared = record.submission.manifest.packageManifest?.lifecycle?.activation === 'hot-reload'
      requireCondition(hotReloadDeclared ? passed(evidence?.checks?.hotReload) : notApplicable(evidence?.checks?.hotReload), `${mode} hotReload check does not match the package manifest`, errors)
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '))

  const output = structuredClone(record)
  output.verification = {
    state: mode === 'guided' ? 'source-evidence-passed' : 'current-baseline-passed',
    verifiedAt: evidence.verifiedAt,
    evidence: `intake/evidence/${record.id}.json`,
  }
  output.tests.static = test(true, 'passed', [
    evidence.checks.manifest.evidence,
    evidence.checks.entry.evidence,
    evidence.checks.dshContract.evidence,
    evidence.checks.compatibility.evidence,
    evidence.checks.permissions.evidence,
  ].join(' | '))
  output.tests.supplyChain = test(true, 'passed', evidence.checks.supplyChain.evidence)
  if (mode === 'guided') {
    output.tests.officialBaseline = test(false, 'not-applicable', 'guided entries expose no executable install intent')
    output.tests.lifecycle = test(false, 'not-applicable', 'guided entries have no Workshop-owned lifecycle')
    output.registry = { state: 'ineligible', reason: 'guided-catalog-only' }
  } else {
    output.tests.officialBaseline = test(true, 'passed', `${baseline.runtime.package}@${baseline.runtime.version} (${baseline.runtime.integrity})`)
    output.tests.lifecycle = test(true, 'passed', `install, ready, ${evidence.capability.id} capability invocation, update, disable, remove, and recovery passed`)
    output.registry = output.review.state === 'approved'
      ? { state: 'eligible', reason: 'approved-and-current-baseline-verified' }
      : { state: 'ineligible', reason: 'review-approval-required' }
  }
  return output
}

export function evaluateRecord(record, baseline) {
  const errors = []
  const mode = record?.classification?.management
  requireCondition(record?.schema === 'omdsh-workshop-intake/v1', `${record?.id || 'record'}: unsupported intake schema`, errors)
  requireCondition(MANAGEMENT_MODES.includes(mode), `${record?.id || 'record'}: unsupported management mode`, errors)
  requireCondition(REVIEW_STATES.includes(record?.review?.state), `${record?.id || 'record'}: invalid review state`, errors)
  requireCondition(VERIFICATION_STATES.includes(record?.verification?.state), `${record?.id || 'record'}: invalid verification state`, errors)
  requireCondition(`${record?.baseline?.package}@${record?.baseline?.version}` === `${baseline.runtime.package}@${baseline.runtime.version}`, `${record?.id || 'record'}: stale official baseline`, errors)
  requireCondition(record?.baseline?.integrity === baseline.runtime.integrity, `${record?.id || 'record'}: baseline integrity mismatch`, errors)
  if (mode === 'guided') {
    requireCondition(record.registry?.state === 'ineligible', `${record.id}: guided entries cannot enter Registry`, errors)
    requireCondition(record.tests?.officialBaseline?.status === 'not-applicable', `${record.id}: guided official baseline must be not-applicable`, errors)
  }
  if (record?.submission?.manifest?.management?.method === 'repository-plugin' && baseline.contracts.repositoryPlugin.status !== 'available') {
    requireCondition(record.verification?.state === 'blocked', `${record.id}: managed verification must remain blocked while the official contract is unavailable`, errors)
    requireCondition(record.registry?.state === 'ineligible', `${record.id}: unavailable managed contract cannot enter Registry`, errors)
  }
  if (['eligible', 'admitted'].includes(record?.registry?.state)) {
    requireCondition(['transactional', 'managed'].includes(mode), `${record.id}: unsupported Registry mode`, errors)
    requireCondition(record.review?.state === 'approved', `${record.id}: Registry requires review approval`, errors)
    requireCondition(record.verification?.state === 'current-baseline-passed', `${record.id}: Registry requires current-baseline verification`, errors)
    for (const name of ['static', 'supplyChain', 'officialBaseline', 'lifecycle']) {
      requireCondition(record.tests?.[name]?.status === 'passed', `${record.id}: ${name} gate did not pass`, errors)
    }
  }
  return errors
}

export function validateQueue(queue, baseline) {
  const errors = []
  requireCondition(queue?.schema === 'omdsh-workshop-intake-queue/v1', 'unsupported intake queue schema', errors)
  requireCondition(queue?.officialBaseline === `${baseline.runtime.package}@${baseline.runtime.version}`, 'intake queue baseline is stale', errors)
  requireCondition(Array.isArray(queue?.records), 'intake queue records must be an array', errors)
  const ids = new Set()
  for (const record of queue?.records || []) {
    if (ids.has(record.id)) errors.push(`${record.id}: duplicate intake record`)
    ids.add(record.id)
    errors.push(...evaluateRecord(record, baseline))
  }
  return errors
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
