import { createHash } from 'node:crypto'

import { managementMode, validateSubmission } from './intake-lib.mjs'
import { MCP_PROTOCOL_CURRENT, MCP_REGISTRY_SCHEMA } from './workshop-manifest-lib.mjs'

export const HARNESS_PLAN_SCHEMA = 'omdsh-workshop-harness-plan/v1'
export const HARNESS_REPORT_SCHEMA = 'omdsh-workshop-harness-report/v1'
export const HARNESS_EVIDENCE_SCHEMA = 'omdsh-workshop-intake-evidence/v2'
export const HARNESS_ENGINE_VERSION = '1.1.0'

const EXECUTORS = new Set(['static', 'profile', 'repository', 'mcp', 'cordis', 'skill', 'third-party', 'loader'])
const PHASES = new Set(['static', 'supply-chain', 'sandbox', 'install', 'ready', 'functional', 'failure', 'lifecycle', 'update', 'disable', 'remove', 'recovery'])
const SCOPES = new Set(['source-only', 'ephemeral-workspace', 'candidate-profile', 'isolated-process', 'current-profile-controlled'])
const RESULT_STATUSES = new Set(['passed', 'failed', 'blocked', 'not-applicable'])
const CAPABILITY_KINDS = new Set(['tool', 'command', 'service', 'ui', 'event', 'provider', 'other'])
const SECRET_RE = /(?:github_pat_|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b)/i

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function harnessEvidenceKey(plan) {
  const input = structuredClone(plan)
  delete input.evidenceKey
  return `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`
}

function requireCondition(condition, message, errors) {
  if (!condition) errors.push(message)
}

function capabilityBindingMismatches(expected, observed) {
  if (!expected || !observed || typeof observed !== 'object') return ['capability declaration missing']
  const mismatches = ['id', 'kind', 'invocation', 'expected']
    .filter((field) => observed[field] !== expected[field])
    .map((field) => `capability.${field}=${JSON.stringify(expected[field])}`)
  if (typeof observed.observed !== 'string' || observed.observed.length === 0) mismatches.push('capability.observed=non-empty-string')
  return mismatches
}

function step(id, phase, executor, scope, expectedFacts, required = true) {
  return { id, phase, executor, required, scope, expectedFacts }
}

function commonSteps(protocol) {
  return [
    step('source.immutable', 'static', 'static', 'source-only', { sourceImmutable: true }),
    step('manifest.validate', 'static', 'static', 'source-only', { manifestValid: true }),
    step('artifact.present', 'static', 'static', 'source-only', { artifactPresent: true }),
    step('protocol.contract', 'static', protocol === 'skill' ? 'skill' : protocol === 'third-party' ? 'third-party' : 'static', 'source-only', { protocolContractValid: true }),
    step('compatibility.baseline', 'static', 'static', 'source-only', { compatibilityPassed: true }),
    step('permissions.review', 'static', 'static', 'source-only', { permissionsReviewed: true }),
    step('supply-chain.review', 'supply-chain', 'static', 'source-only', { supplyChainPassed: true, installScriptsDisabled: true }),
  ]
}

function lifecycleSteps(declaration, executor, scope) {
  const activation = declaration.lifecycle.activation
  if (activation === 'hot-reload') {
    return [
      step('lifecycle.dispose', 'lifecycle', executor, scope, { disposed: true }),
      step('lifecycle.reactivate', 'lifecycle', executor, scope, { reactivated: true, capabilityObserved: true }),
    ]
  }
  if (activation.startsWith('restart-')) {
    return [step('lifecycle.restart', 'lifecycle', executor, scope, { restarted: true, restartScope: activation.slice('restart-'.length), capabilityObserved: true })]
  }
  return []
}

function profileSteps(declaration, hasPreviousRelease) {
  return [
    ...(hasPreviousRelease ? [step('update-source.immutable', 'static', 'static', 'source-only', { sourceImmutable: true, previousVersionMatched: true })] : []),
    step('sandbox.policy', 'sandbox', 'profile', 'ephemeral-workspace', { workspaceEphemeral: true, networkDeniedByDefault: true, installScriptsDisabled: true, currentProtected: true }),
    step('runtime.exact', 'sandbox', 'profile', 'candidate-profile', { runtimeExact: true, profileBaseExact: true }),
    step('candidate.create', 'sandbox', 'profile', 'candidate-profile', { candidateCreated: true, currentUntouched: true, profileBaseBound: true }),
    step('install.scripts-disabled', 'install', 'profile', 'candidate-profile', { installScriptsDisabled: true }),
    step('install.apply', 'install', 'profile', 'candidate-profile', { installed: true, currentUntouched: true }),
    step('ready.probe', 'ready', 'profile', 'candidate-profile', { ready: true }),
    step('capability.invoke', 'functional', 'profile', 'candidate-profile', { capabilityObserved: true }),
    step('failure.inject-candidate', 'failure', 'profile', 'candidate-profile', { failureInjected: true }),
    step('failure.current-unchanged', 'failure', 'profile', 'current-profile-controlled', { currentUnchanged: true }),
    step('failure.discard-candidate', 'failure', 'profile', 'candidate-profile', { candidateDiscarded: true }),
    step('activation.switch', 'lifecycle', 'profile', 'current-profile-controlled', { activated: true, previousRetained: true }),
    ...lifecycleSteps(declaration, 'profile', 'current-profile-controlled'),
    ...(hasPreviousRelease ? [step('update.apply', 'update', 'profile', 'candidate-profile', { updatePassed: true })] : []),
    step('disable.apply', 'disable', 'profile', 'candidate-profile', { disablePassed: true }),
    step('remove.apply', 'remove', 'profile', 'candidate-profile', { removePassed: true }),
    step('recovery.generation', 'recovery', 'profile', 'current-profile-controlled', { recoveryPassed: true, previousRestored: true }),
  ]
}

function repositorySteps(declaration, hasPreviousRelease) {
  return [
    ...(hasPreviousRelease ? [step('update-source.immutable', 'static', 'static', 'source-only', { sourceImmutable: true, previousVersionMatched: true })] : []),
    step('sandbox.policy', 'sandbox', 'repository', 'ephemeral-workspace', { workspaceEphemeral: true, networkDeniedByDefault: true, installScriptsDisabled: true, currentProtected: true }),
    step('runtime.exact', 'sandbox', 'repository', 'candidate-profile', { runtimeExact: true }),
    step('candidate.create', 'sandbox', 'repository', 'candidate-profile', { candidateCreated: true, currentUntouched: true }),
    step('repository.install', 'install', 'repository', 'candidate-profile', { installed: true, installScriptsDisabled: true, currentUntouched: true }),
    step('ready.probe', 'ready', 'repository', 'candidate-profile', { ready: true }),
    step('capability.invoke', 'functional', 'repository', 'candidate-profile', { capabilityObserved: true }),
    step('failure.inject-candidate', 'failure', 'repository', 'candidate-profile', { failureInjected: true }),
    step('failure.current-unchanged', 'failure', 'repository', 'current-profile-controlled', { currentUnchanged: true }),
    step('failure.discard-candidate', 'failure', 'repository', 'candidate-profile', { candidateDiscarded: true }),
    ...lifecycleSteps(declaration, 'repository', 'candidate-profile'),
    ...(hasPreviousRelease ? [step('update.apply', 'update', 'repository', 'candidate-profile', { updatePassed: true })] : []),
    step('disable.apply', 'disable', 'repository', 'candidate-profile', { disablePassed: true }),
    step('remove.apply', 'remove', 'repository', 'candidate-profile', { removePassed: true }),
    step('recovery.candidate', 'recovery', 'repository', 'candidate-profile', { recoveryPassed: true, candidateDiscarded: true }),
  ]
}

function mcpSteps(declaration) {
  return [
    step('mcp.server-manifest', 'static', 'mcp', 'source-only', { registrySchema: MCP_REGISTRY_SCHEMA, serverManifestValid: true }),
    step('mcp.ownership', 'supply-chain', 'mcp', 'source-only', { packageOwnershipBound: true }),
    step('sandbox.policy', 'sandbox', 'mcp', 'ephemeral-workspace', { workspaceEphemeral: true, networkDeniedByDefault: true, installScriptsDisabled: true, currentProtected: true }),
    step('mcp.process-create', 'sandbox', 'mcp', 'isolated-process', { processIsolated: true, currentUntouched: true }),
    step('mcp.discover', 'ready', 'mcp', 'isolated-process', { protocolVersion: MCP_PROTOCOL_CURRENT, discovered: true, stateless: true }),
    step('mcp.tools-list', 'ready', 'mcp', 'isolated-process', { toolsListed: true }),
    step('capability.invoke', 'functional', 'mcp', 'isolated-process', { capabilityObserved: true }),
    step('failure.inject-process', 'failure', 'mcp', 'isolated-process', { failureInjected: true }),
    step('failure.current-unchanged', 'failure', 'mcp', 'current-profile-controlled', { currentUnchanged: true }),
    step('failure.discard-process', 'failure', 'mcp', 'isolated-process', { processDiscarded: true }),
    ...lifecycleSteps(declaration, 'mcp', 'isolated-process'),
    step('remove.apply', 'remove', 'mcp', 'isolated-process', { removePassed: true, processRemoved: true }),
  ]
}

function cordisSteps(declaration) {
  return [
    step('cordis.service-contract', 'static', 'cordis', 'source-only', { serviceContractValid: true }),
    step('sandbox.policy', 'sandbox', 'cordis', 'ephemeral-workspace', { workspaceEphemeral: true, networkDeniedByDefault: true, installScriptsDisabled: true, currentProtected: true }),
    step('cordis.process-create', 'sandbox', 'cordis', 'isolated-process', { processIsolated: true, currentUntouched: true }),
    step('cordis.init', 'ready', 'cordis', 'isolated-process', { initialized: true, ready: true }),
    step('capability.invoke', 'functional', 'cordis', 'isolated-process', { capabilityObserved: true }),
    step('failure.inject-process', 'failure', 'cordis', 'isolated-process', { failureInjected: true }),
    step('failure.current-unchanged', 'failure', 'cordis', 'current-profile-controlled', { currentUnchanged: true }),
    step('failure.discard-process', 'failure', 'cordis', 'isolated-process', { processDiscarded: true }),
    ...lifecycleSteps(declaration, 'cordis', 'isolated-process'),
    step('cordis.dispose', 'remove', 'cordis', 'isolated-process', { disposed: true, processRemoved: true }),
  ]
}

function skillSteps() {
  return [
    step('skill.frontmatter', 'static', 'skill', 'source-only', { frontmatterValid: true }),
    step('skill.references', 'static', 'skill', 'source-only', { referencesResolved: true, pathsContained: true }),
    step('skill.commands-review', 'supply-chain', 'skill', 'source-only', { executableIntentReviewed: true }),
  ]
}

function thirdPartySteps() {
  return [
    step('guide.fixed-source', 'static', 'third-party', 'source-only', { guidePinned: true }),
    step('guide.permissions', 'static', 'third-party', 'source-only', { permissionBoundaryDocumented: true }),
    step('guide.reproducibility', 'static', 'third-party', 'source-only', { manualStepsReproducible: true }),
  ]
}

function loaderSteps(declaration, descriptor, hasPreviousRelease) {
  const phases = new Set(descriptor.lifecycle)
  const scope = declaration.install.failurePolicy === 'discard-process' ? 'isolated-process' : 'candidate-profile'
  return [
    ...(descriptor.execution === 'trusted-ephemeral'
      ? [step('sandbox.policy', 'sandbox', 'loader', 'ephemeral-workspace', { workspaceEphemeral: true, networkDeniedByDefault: true, installScriptsDisabled: true, currentProtected: true })]
      : []),
    ...(phases.has('install-candidate') ? [
      step('candidate.create', 'sandbox', 'loader', scope, { candidateCreated: true, currentUntouched: true }),
      step('install.apply', 'install', 'loader', scope, { installed: true, currentUntouched: true }),
    ] : []),
    ...(phases.has('ready') ? [step('ready.probe', 'ready', 'loader', scope, { ready: true })] : []),
    ...(phases.has('invoke') ? [step('capability.invoke', 'functional', 'loader', scope, { capabilityObserved: true })] : []),
    ...(phases.has('inject-failure') ? [
      step('failure.inject-adapter', 'failure', 'loader', scope, { failureInjected: true }),
      step('failure.current-unchanged', 'failure', 'loader', 'current-profile-controlled', { currentUnchanged: true }),
      step('failure.discard-adapter', 'failure', 'loader', scope, { failureDiscarded: true }),
    ] : []),
    ...(phases.has('activate') ? [step('activation.switch', 'lifecycle', 'loader', 'current-profile-controlled', { activated: true })] : []),
    ...lifecycleSteps(declaration, 'loader', scope),
    ...(hasPreviousRelease && phases.has('update') ? [step('update.apply', 'update', 'loader', scope, { updatePassed: true })] : []),
    ...(phases.has('disable') ? [step('disable.apply', 'disable', 'loader', scope, { disablePassed: true })] : []),
    ...(phases.has('remove') ? [step('remove.apply', 'remove', 'loader', scope, { removePassed: true })] : []),
    ...(phases.has('rollback') ? [step('recovery.adapter', 'recovery', 'loader', scope, { recoveryPassed: true })] : []),
  ]
}

function plannedClaims(declaration, baseline, management, loaderDescriptor = null) {
  const install = declaration.install
  const protocol = declaration.integration.protocol
  const repositoryBlocked = install.adapter === 'repository-plugin' && baseline.contracts?.repositoryPlugin?.status !== 'available'
  return {
    seamlessInstall: install.mode === 'transactional'
      ? { state: 'candidate', reason: 'requires complete candidate-profile lifecycle and generation recovery' }
      : { state: 'not-claimed', reason: 'only transactional Profile Bundle installation can claim seamless installation' },
    failureIsolation: ['transactional', 'isolated-trial'].includes(install.mode)
      ? { state: 'candidate', reason: `requires failure injection and ${install.failurePolicy}` }
      : { state: 'not-claimed', reason: 'guided installation has manual failure handling' },
    hotReload: declaration.lifecycle.activation === 'hot-reload'
      ? { state: 'candidate', reason: 'requires dispose, reactivation, and capability observation' }
      : { state: 'not-declared', reason: `declared activation is ${declaration.lifecycle.activation}` },
    protocolCompatibility: { state: 'candidate', reason: `requires ${protocol} contract checks at the fixed source` },
    registryReadiness: loaderDescriptor?.authority === 'blocked' || repositoryBlocked
      ? { state: 'blocked', reason: repositoryBlocked
          ? 'official Repository Plugin contract is unavailable in the current baseline'
          : 'the selected Loader Adapter authority is blocked' }
      : loaderDescriptor?.authority === 'catalog-only'
        ? { state: 'catalog-only', reason: 'the selected Loader Adapter does not grant Registry installation authority' }
        : loaderDescriptor?.authority === 'registry-eligible-after-evidence' || ['transactional', 'managed'].includes(management)
        ? { state: 'candidate', reason: 'Harness evidence can proceed to independent maintainer review' }
        : { state: 'catalog-only', reason: 'this protocol has no current Workshop Registry install authority' },
  }
}

function profileBase(declaration, baseline) {
  if (declaration.install.adapter !== 'profile-bundle') return null
  const permissions = new Set(declaration.permissions || [])
  const template = permissions.has('ui:extend') || permissions.has('webserver:register') ? 'web' : 'base'
  const configured = baseline.contracts?.profileBundle?.templates?.[template]
  if (!configured) throw new Error(`official baseline does not define the ${template} Profile template`)
  return { template, ...structuredClone(configured) }
}

export function createHarnessPlan(submission, baseline, loaderDescriptor = null) {
  const errors = validateSubmission(submission)
  if (submission?.schema !== 'omdsh-workshop-submission/v2') errors.push('typed Harness requires a v2 submission with package.json#dshWorkshop')
  if (errors.length > 0) throw new Error(errors.join('; '))

  const declaration = submission.packageManifest
  const management = managementMode(submission.management.method)
  const protocol = declaration.integration.protocol
  const builtInAdapters = new Set(['profile-bundle', 'repository-plugin', 'mcp-server', 'skill', 'third-party'])
  if (!builtInAdapters.has(declaration.install.adapter) && !loaderDescriptor) {
    throw new Error(`custom loader ${declaration.install.adapter}/${protocol} requires a trusted Adapter Registry descriptor`)
  }
  if (loaderDescriptor && (loaderDescriptor.match.installAdapter !== declaration.install.adapter || loaderDescriptor.match.protocol !== protocol)) {
    throw new Error('Loader Adapter descriptor does not match the package manifest binding')
  }
  const blockedReasons = []
  if (declaration.install.adapter === 'repository-plugin' && baseline.contracts?.repositoryPlugin?.status !== 'available') {
    blockedReasons.push('official-repository-plugin-contract-unavailable')
  }
  if (protocol === 'mcp') {
    if (baseline.contracts?.mcp?.currentProtocolVersion !== MCP_PROTOCOL_CURRENT) blockedReasons.push('official-mcp-protocol-baseline-mismatch')
    if (baseline.contracts?.mcp?.registrySchema !== MCP_REGISTRY_SCHEMA) blockedReasons.push('official-mcp-registry-schema-baseline-mismatch')
  }

  let typedSteps = []
  const hasPreviousRelease = submission.release.updateFrom !== null
  if (declaration.install.adapter === 'profile-bundle') typedSteps = profileSteps(declaration, hasPreviousRelease)
  else if (declaration.install.adapter === 'repository-plugin') typedSteps = repositorySteps(declaration, hasPreviousRelease)
  else if (declaration.install.adapter === 'mcp-server') typedSteps = mcpSteps(declaration)
  else if (protocol === 'harness-cordis') typedSteps = cordisSteps(declaration)
  else if (declaration.install.adapter === 'skill') typedSteps = skillSteps()
  else if (loaderDescriptor) typedSteps = loaderSteps(declaration, loaderDescriptor, hasPreviousRelease)
  else typedSteps = thirdPartySteps()

  const plan = {
    schema: HARNESS_PLAN_SCHEMA,
    engineVersion: HARNESS_ENGINE_VERSION,
    id: `${submission.project.id}@${submission.release.version}:${baseline.runtime.version}:${protocol}`,
    projectId: submission.project.id,
    releaseId: `${submission.project.id}@${submission.release.version}`,
    source: {
      repository: submission.project.repository.replace(/\/$/, ''),
      ref: submission.release.ref,
      path: submission.project.path ?? null,
    },
    updateFrom: submission.release.updateFrom ? {
      repository: submission.project.repository.replace(/\/$/, ''),
      ref: submission.release.updateFrom.ref,
      path: submission.project.path ?? null,
      version: submission.release.updateFrom.version,
    } : null,
    baseline: {
      package: baseline.runtime.package,
      version: baseline.runtime.version,
      integrity: baseline.runtime.integrity,
    },
    profileBase: profileBase(declaration, baseline),
    loaderAdapter: loaderDescriptor ? {
      id: loaderDescriptor.id,
      version: loaderDescriptor.version,
      execution: loaderDescriptor.execution,
      authority: loaderDescriptor.authority,
    } : null,
    classification: {
      management,
      installMode: declaration.install.mode,
      adapter: declaration.install.adapter,
      protocol,
      failurePolicy: declaration.install.failurePolicy,
      activation: declaration.lifecycle.activation,
    },
    capability: declaration.capability ? structuredClone(declaration.capability) : null,
    policy: {
      sourceExecution: 'disabled-until-explicitly-trusted',
      workspace: 'ephemeral',
      network: 'deny-by-default',
      installScripts: 'disabled',
      currentProfile: 'read-only-until-controlled-activation',
      cleanup: 'mandatory',
    },
    claims: plannedClaims(declaration, baseline, management, loaderDescriptor),
    blockedReasons,
    steps: [...commonSteps(protocol), ...typedSteps],
  }
  plan.evidenceKey = harnessEvidenceKey(plan)
  const planErrors = validateHarnessPlan(plan)
  if (planErrors.length > 0) throw new Error(planErrors.join('; '))
  return plan
}

export function validateHarnessPlan(plan) {
  const errors = []
  requireCondition(plan?.schema === HARNESS_PLAN_SCHEMA, 'unsupported Harness plan schema', errors)
  requireCondition(plan?.engineVersion === HARNESS_ENGINE_VERSION, 'unsupported Harness engine version', errors)
  requireCondition(/^sha256:[0-9a-f]{64}$/.test(plan?.evidenceKey || ''), 'Harness evidence key is invalid', errors)
  requireCondition(plan?.evidenceKey === harnessEvidenceKey(plan), 'Harness evidence key does not match the plan', errors)
  requireCondition(typeof plan?.id === 'string' && plan.id.length > 2, 'Harness plan id is required', errors)
  requireCondition(/^[0-9a-f]{40}$/.test(plan?.source?.ref || ''), 'Harness source must use a fixed commit', errors)
  requireCondition(plan?.baseline?.package === '@deepseek-ai/dsh', 'Harness baseline package is invalid', errors)
  requireCondition(/^sha512-/.test(plan?.baseline?.integrity || ''), 'Harness baseline integrity is required', errors)
  requireCondition(plan?.loaderAdapter === null || typeof plan?.loaderAdapter === 'object', 'Harness Loader Adapter binding is invalid', errors)
  if (plan?.loaderAdapter) {
    requireCondition(/^[a-z0-9][a-z0-9.-]*$/.test(plan.loaderAdapter.id || ''), 'Harness Loader Adapter id is invalid', errors)
    requireCondition(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(plan.loaderAdapter.version || ''), 'Harness Loader Adapter version must be exact semver', errors)
    requireCondition(['static', 'trusted-ephemeral'].includes(plan.loaderAdapter.execution), 'Harness Loader Adapter execution boundary is invalid', errors)
    requireCondition(['registry-eligible-after-evidence', 'catalog-only', 'blocked'].includes(plan.loaderAdapter.authority), 'Harness Loader Adapter authority is invalid', errors)
  }
  if (plan?.classification?.adapter === 'profile-bundle') {
    requireCondition(['base', 'web'].includes(plan?.profileBase?.template), 'Profile Harness requires a fixed base template', errors)
    requireCondition(Array.isArray(plan?.profileBase?.bundles) && plan.profileBase.bundles[0] === '@deepseek-ai/dsh-base', 'Profile base must start with @deepseek-ai/dsh-base', errors)
    requireCondition(Array.isArray(plan?.profileBase?.exactPackages) && plan.profileBase.exactPackages.length === plan.profileBase.bundles.length, 'Profile base exact package bindings are required', errors)
    for (const binding of plan?.profileBase?.exactPackages || []) {
      requireCondition(plan.profileBase.bundles.includes(binding.package), `Profile base package ${binding.package} is not a configured bundle`, errors)
      requireCondition(typeof binding.version === 'string' && binding.version.length > 0, `Profile base package ${binding.package} requires an exact version`, errors)
      requireCondition(/^sha512-/.test(binding.integrity || ''), `Profile base package ${binding.package} requires sha512 integrity`, errors)
    }
  } else {
    requireCondition(plan?.profileBase === null, 'non-Profile Harness plan cannot declare a Profile base', errors)
  }
  requireCondition(plan?.policy?.sourceExecution === 'disabled-until-explicitly-trusted', 'untrusted source execution must be disabled', errors)
  requireCondition(plan?.policy?.workspace === 'ephemeral', 'Harness workspace must be ephemeral', errors)
  requireCondition(plan?.policy?.network === 'deny-by-default', 'Harness network must be denied by default', errors)
  requireCondition(plan?.policy?.installScripts === 'disabled', 'install scripts must be disabled', errors)
  requireCondition(plan?.policy?.currentProfile === 'read-only-until-controlled-activation', 'current Profile must be protected', errors)
  requireCondition(Array.isArray(plan?.steps) && plan.steps.length > 0, 'Harness plan requires steps', errors)
  const ids = new Set()
  for (const item of plan?.steps || []) {
    requireCondition(typeof item.id === 'string' && /^[a-z][a-z0-9.-]*$/.test(item.id), 'Harness step id is invalid', errors)
    requireCondition(!ids.has(item.id), `duplicate Harness step ${item.id}`, errors)
    ids.add(item.id)
    requireCondition(PHASES.has(item.phase), `${item.id}: invalid phase`, errors)
    requireCondition(EXECUTORS.has(item.executor), `${item.id}: invalid executor`, errors)
    requireCondition(SCOPES.has(item.scope), `${item.id}: invalid scope`, errors)
    requireCondition(item.expectedFacts && Object.keys(item.expectedFacts).length > 0, `${item.id}: expected facts are required`, errors)
  }
  const invokesCapability = ids.has('capability.invoke')
  if (invokesCapability) {
    requireCondition(plan?.capability && typeof plan.capability === 'object', 'executable Harness plan requires a named capability target', errors)
    requireCondition(/^[a-z0-9][a-z0-9._-]*$/.test(plan?.capability?.id || ''), 'Harness capability id is invalid', errors)
    requireCondition(CAPABILITY_KINDS.has(plan?.capability?.kind), 'Harness capability kind is invalid', errors)
    requireCondition(typeof plan?.capability?.invocation === 'string' && plan.capability.invocation.length > 0, 'Harness capability invocation is required', errors)
    requireCondition(typeof plan?.capability?.expected === 'string' && plan.capability.expected.length > 0, 'Harness capability expected result is required', errors)
  } else {
    requireCondition(plan?.capability === null, 'static-only Harness plan cannot claim a runtime capability target', errors)
  }
  if (ids.has('update.apply')) {
    requireCondition(plan?.updateFrom && typeof plan.updateFrom === 'object', 'Harness update test requires a fixed previous release source', errors)
    requireCondition(/^[0-9a-f]{40}$/.test(plan?.updateFrom?.ref || ''), 'Harness previous release must use a fixed commit', errors)
    requireCondition(plan?.updateFrom?.ref !== plan?.source?.ref, 'Harness previous release commit must differ from the target commit', errors)
    requireCondition(typeof plan?.updateFrom?.version === 'string' && plan.updateFrom.version.length > 0, 'Harness previous release version is required', errors)
  } else {
    requireCondition(plan?.updateFrom === null, 'Harness plan without an update step cannot bind an update source', errors)
  }
  if (plan?.classification?.installMode === 'transactional') {
    for (const id of ['candidate.create', 'install.apply', 'failure.current-unchanged', 'activation.switch']) {
      requireCondition(ids.has(id), `transactional Harness requires ${id}`, errors)
    }
    requireCondition(ids.has('recovery.generation') || ids.has('recovery.adapter'), 'transactional Harness requires recovery', errors)
  }
  if (plan?.classification?.installMode === 'isolated-trial') {
    requireCondition(ids.has('failure.current-unchanged'), 'isolated Harness requires current protection evidence', errors)
  }
  if (plan?.classification?.activation === 'hot-reload') {
    requireCondition(ids.has('lifecycle.dispose') && ids.has('lifecycle.reactivate'), 'hot reload requires dispose and reactivate steps', errors)
  }
  return [...new Set(errors)]
}

function factMismatches(expected, observed = {}) {
  return Object.entries(expected).filter(([key, value]) => observed[key] !== value).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
}

function blockedStep(item, reason) {
  return { id: item.id, status: 'blocked', evidence: reason, facts: {} }
}

function resultClaims(plan, status) {
  return Object.fromEntries(Object.entries(plan.claims).map(([name, claim]) => {
    if (claim.state !== 'candidate') return [name, claim]
    if (status === 'passed') {
      return [name, name === 'registryReadiness'
        ? { state: 'evidence-ready', reason: 'Harness passed; independent review is still required' }
        : { state: 'verified', reason: 'all required typed Harness steps passed' }]
    }
    return [name, { state: status === 'blocked' ? 'blocked' : 'failed', reason: `typed Harness ${status}` }]
  }))
}

export async function runHarnessPlan(plan, adapter, { verifiedAt = new Date().toISOString(), verifier = 'local-harness' } = {}) {
  const errors = validateHarnessPlan(plan)
  if (errors.length > 0) throw new Error(errors.join('; '))
  if (!adapter || adapter.trustedSourceExecution !== true || typeof adapter.run !== 'function' || typeof adapter.cleanup !== 'function') {
    throw new Error('Harness execution requires an explicitly trusted adapter with run and cleanup handlers')
  }

  const results = []
  let halted = plan.blockedReasons.length > 0
  let terminalStatus = halted ? 'blocked' : 'passed'
  for (const item of plan.steps) {
    if (halted) {
      results.push(blockedStep(item, plan.blockedReasons.join(', ') || 'blocked by an earlier required step'))
      continue
    }
    try {
      const raw = await adapter.run(item, { plan })
      let status = RESULT_STATUSES.has(raw?.status) ? raw.status : 'failed'
      const facts = raw?.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts) ? raw.facts : {}
      const mismatches = status === 'passed' ? factMismatches(item.expectedFacts, facts) : []
      if (status === 'passed' && item.id === 'capability.invoke') mismatches.push(...capabilityBindingMismatches(plan.capability, raw?.capability))
      if (mismatches.length > 0) status = 'failed'
      const result = {
        id: item.id,
        status,
        evidence: mismatches.length > 0
          ? `${raw?.evidence || 'adapter result'}; Harness contract mismatch: ${mismatches.join(', ')}`
          : String(raw?.evidence || `${item.id}: ${status}`),
        facts,
        ...(raw?.capability ? { capability: raw.capability } : {}),
      }
      results.push(result)
      if (item.required && status !== 'passed') {
        halted = true
        terminalStatus = status === 'blocked' ? 'blocked' : 'failed'
      }
    } catch (error) {
      results.push({ id: item.id, status: 'failed', evidence: `${item.id}: ${error.message}`, facts: {} })
      halted = true
      terminalStatus = 'failed'
    }
  }

  let cleanup
  try {
    const raw = await adapter.cleanup({ plan, results })
    const passed = raw?.status === 'passed' && raw?.facts?.workspaceRemoved === true
    cleanup = {
      status: passed ? 'passed' : raw?.status === 'blocked' ? 'blocked' : 'failed',
      evidence: String(raw?.evidence || 'Harness cleanup result'),
      facts: raw?.facts && typeof raw.facts === 'object' ? raw.facts : { workspaceRemoved: false },
    }
    if (!passed) terminalStatus = cleanup.status === 'blocked' && terminalStatus === 'blocked' ? 'blocked' : 'failed'
  } catch (error) {
    cleanup = { status: 'failed', evidence: `cleanup: ${error.message}`, facts: { workspaceRemoved: false } }
    terminalStatus = 'failed'
  }

  const report = {
    schema: HARNESS_REPORT_SCHEMA,
    engineVersion: plan.engineVersion,
    evidenceKey: plan.evidenceKey,
    planId: plan.id,
    projectId: plan.projectId,
    releaseId: plan.releaseId,
    source: structuredClone(plan.source),
    updateFrom: structuredClone(plan.updateFrom),
    baseline: structuredClone(plan.baseline),
    profileBase: structuredClone(plan.profileBase),
    loaderAdapter: structuredClone(plan.loaderAdapter),
    classification: structuredClone(plan.classification),
    status: terminalStatus,
    execution: {
      adapter: String(adapter.name || 'trusted-adapter'),
      trustedSourceExecution: true,
      workspace: 'ephemeral',
    },
    steps: results,
    cleanup,
    claims: resultClaims(plan, terminalStatus),
    verifiedAt,
    verifier,
  }
  const reportErrors = validateHarnessReport(report, plan)
  if (reportErrors.length > 0) throw new Error(reportErrors.join('; '))
  return report
}

export function validateHarnessReport(report, plan) {
  const errors = []
  requireCondition(report?.schema === HARNESS_REPORT_SCHEMA, 'unsupported Harness report schema', errors)
  requireCondition(report?.engineVersion === plan?.engineVersion, 'Harness report engine binding mismatch', errors)
  requireCondition(report?.evidenceKey === plan?.evidenceKey, 'Harness report evidence-key binding mismatch', errors)
  requireCondition(report?.planId === plan?.id, 'Harness report plan binding mismatch', errors)
  requireCondition(report?.projectId === plan?.projectId && report?.releaseId === plan?.releaseId, 'Harness report release binding mismatch', errors)
  requireCondition(JSON.stringify(report?.source) === JSON.stringify(plan?.source), 'Harness report source binding mismatch', errors)
  requireCondition(JSON.stringify(report?.updateFrom) === JSON.stringify(plan?.updateFrom), 'Harness report update-source binding mismatch', errors)
  requireCondition(JSON.stringify(report?.baseline) === JSON.stringify(plan?.baseline), 'Harness report baseline binding mismatch', errors)
  requireCondition(JSON.stringify(report?.profileBase) === JSON.stringify(plan?.profileBase), 'Harness report Profile base binding mismatch', errors)
  requireCondition(JSON.stringify(report?.loaderAdapter) === JSON.stringify(plan?.loaderAdapter), 'Harness report Loader Adapter binding mismatch', errors)
  requireCondition(['passed', 'failed', 'blocked'].includes(report?.status), 'Harness report status is invalid', errors)
  requireCondition(report?.execution?.trustedSourceExecution === true, 'Harness report must record explicit source trust', errors)
  requireCondition(report?.execution?.workspace === 'ephemeral', 'Harness report must use an ephemeral workspace', errors)
  requireCondition(!SECRET_RE.test(JSON.stringify(report)), 'Harness report appears to contain a credential or private key', errors)
  requireCondition(typeof report?.verifiedAt === 'string' && new Date(report.verifiedAt).toISOString() === report.verifiedAt, 'Harness report timestamp must be normalized ISO', errors)
  requireCondition(typeof report?.verifier === 'string' && report.verifier.length > 0, 'Harness report verifier is required', errors)
  requireCondition(Array.isArray(report?.steps) && report.steps.length === plan?.steps?.length, 'Harness report must cover every planned step', errors)
  for (let index = 0; index < (plan?.steps?.length || 0); index += 1) {
    const planned = plan.steps[index]
    const observed = report?.steps?.[index]
    requireCondition(observed?.id === planned.id, `Harness report step order mismatch at ${planned.id}`, errors)
    if (observed?.status === 'passed') {
      requireCondition(factMismatches(planned.expectedFacts, observed.facts).length === 0, `${planned.id}: passed without expected facts`, errors)
      if (planned.id === 'capability.invoke') {
        requireCondition(observed.capability && typeof observed.capability === 'object', 'capability.invoke must record the invoked capability', errors)
        requireCondition(capabilityBindingMismatches(plan.capability, observed.capability).length === 0, 'capability.invoke result does not match the fixed plan capability target', errors)
      }
    }
    requireCondition(typeof observed?.evidence === 'string' && observed.evidence.length > 0 && observed.evidence.length <= 4096, `${planned.id}: evidence text must be 1-4096 characters`, errors)
  }
  requireCondition(report?.cleanup?.status === 'passed' && report?.cleanup?.facts?.workspaceRemoved === true || report?.status !== 'passed', 'passed Harness report requires successful cleanup', errors)
  if (report?.status === 'passed') requireCondition(report.steps.every((result, index) => !plan.steps[index].required || result.status === 'passed'), 'passed Harness report contains an incomplete required step', errors)
  return [...new Set(errors)]
}

function evidenceCheck(reportById, id, fallback = 'not-applicable') {
  const result = reportById.get(id)
  if (!result) return { status: fallback, evidence: `${id}: not part of this typed Harness plan` }
  return { status: result.status, evidence: result.evidence }
}

export function harnessReportToEvidence({ record, report, baseline, environment, verifier = report.verifier }) {
  if (report?.status !== 'passed') throw new Error('only a passed Harness report can produce Intake evidence')
  requireCondition(record?.id === report.releaseId, 'Harness report does not match the Intake record', [])
  if (record?.id !== report.releaseId
    || record?.submission?.repository !== report.source.repository
    || record?.submission?.ref !== report.source.ref
    || (record?.submission?.path ?? null) !== (report.source.path ?? null)) {
    throw new Error('Harness report coordinates do not match the Intake record')
  }
  if (`${baseline.runtime.package}@${baseline.runtime.version}` !== `${report.baseline.package}@${report.baseline.version}`
    || baseline.runtime.integrity !== report.baseline.integrity) {
    throw new Error('Harness report does not match the current official baseline')
  }

  const guided = record.classification.management === 'guided'
  const byId = new Map(report.steps.map((result) => [result.id, result]))
  const capabilityResult = report.steps.find((result) => result.capability)
  const installId = report.classification.adapter === 'repository-plugin' ? 'repository.install' : 'install.apply'
  const recoveryId = report.classification.adapter === 'repository-plugin'
    ? 'recovery.candidate'
    : byId.has('recovery.adapter') ? 'recovery.adapter' : 'recovery.generation'
  const runtimeStatus = guided ? 'not-applicable' : 'passed'
  const runtimeCheck = (id) => guided ? { status: 'not-applicable', evidence: `${id}: protocol is Catalog-only in the current DSH Registry` } : evidenceCheck(byId, id)
  const hotReloadDeclared = record.submission.manifest.packageManifest?.lifecycle?.activation === 'hot-reload'
  const hotReload = guided || !hotReloadDeclared
    ? { status: 'not-applicable', evidence: guided ? 'guided protocols cannot claim a DSH runtime hot reload' : 'hot reload was not declared' }
    : {
        status: byId.get('lifecycle.dispose')?.status === 'passed' && byId.get('lifecycle.reactivate')?.status === 'passed' ? 'passed' : 'failed',
        evidence: [byId.get('lifecycle.dispose')?.evidence, byId.get('lifecycle.reactivate')?.evidence].filter(Boolean).join(' | ') || 'hot reload evidence missing',
      }

  return {
    schema: HARNESS_EVIDENCE_SCHEMA,
    projectId: record.submission.manifest.project.id,
    releaseId: record.id,
    management: record.classification.management,
    source: structuredClone(report.source),
    runtime: guided ? null : {
      package: report.baseline.package,
      version: report.baseline.version,
      integrity: report.baseline.integrity,
      profile: String(environment?.profile || 'typed-harness'),
      platform: String(environment?.platform || 'ephemeral-harness'),
      node: String(environment?.node || process.versions.node),
    },
    capability: guided ? null : {
      ...capabilityResult.capability,
      assertion: 'registered-invoked-and-observed',
    },
    checks: {
      static: evidenceCheck(byId, 'source.immutable'),
      manifest: evidenceCheck(byId, 'manifest.validate'),
      entry: evidenceCheck(byId, 'artifact.present'),
      dshContract: evidenceCheck(byId, 'protocol.contract'),
      compatibility: evidenceCheck(byId, 'compatibility.baseline'),
      permissions: evidenceCheck(byId, 'permissions.review'),
      supplyChain: evidenceCheck(byId, 'supply-chain.review'),
      install: runtimeCheck(installId),
      ready: runtimeCheck('ready.probe'),
      functional: guided ? { status: 'not-applicable', evidence: 'guided protocol has no DSH runtime capability claim' } : evidenceCheck(byId, 'capability.invoke'),
      update: runtimeCheck('update.apply'),
      disable: runtimeCheck('disable.apply'),
      remove: runtimeCheck('remove.apply'),
      recovery: runtimeCheck(recoveryId),
      failureIsolation: guided ? { status: 'not-applicable', evidence: 'guided protocol has manual failure handling' } : evidenceCheck(byId, 'failure.current-unchanged'),
      hotReload,
    },
    verifiedAt: report.verifiedAt,
    verifier,
  }
}
