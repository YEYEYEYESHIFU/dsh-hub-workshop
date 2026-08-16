export const WORKSHOP_MANIFEST_SCHEMA = 'omdsh-workshop-package/v1'
export const MCP_PROTOCOL_CURRENT = '2026-07-28'
export const MCP_PROTOCOL_LEGACY = '2025-11-25'
export const MCP_REGISTRY_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'

const MODES = new Set(['transactional', 'isolated-trial', 'guided'])
const FAILURE_POLICIES = new Set(['generation-rollback', 'discard-candidate', 'discard-process', 'manual'])
const ACTIVATIONS = new Set(['immediate', 'hot-reload', 'restart-plugin', 'restart-profile', 'restart-host'])
const DISPOSE = new Set(['supported', 'unsupported', 'unknown'])
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const PERMISSION_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/
const MCP_VERSION_RE = /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/
const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const CAPABILITY_KINDS = new Set(['tool', 'command', 'service', 'ui', 'event', 'provider', 'other'])
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9.-]{0,127}$/
const BUILTIN_PROTOCOL_ADAPTERS = {
  'harness-profile': ['profile-bundle'],
  'harness-repository': ['repository-plugin'],
  'harness-cordis': ['third-party'],
  mcp: ['mcp-server'],
  skill: ['skill'],
  'third-party': ['third-party'],
}
const BUILTIN_ADAPTERS = new Set(Object.values(BUILTIN_PROTOCOL_ADAPTERS).flat())
const STATIC_PROTOCOLS = new Set(['skill', 'third-party'])

const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
const uniqueStrings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string') && new Set(value).size === value.length
const pathOrNull = (value) => value === null || (typeof value === 'string' && PATH_RE.test(value))

export function validateWorkshopManifest(manifest) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(object(manifest), 'package.json#dshWorkshop must be an object')
  if (!object(manifest)) return errors
  require(manifest.schema === WORKSHOP_MANIFEST_SCHEMA, 'unsupported dshWorkshop schema')
  require(manifest.type === 'plugin', 'dshWorkshop.type must be plugin')

  const integration = manifest.integration || {}
  const install = manifest.install || {}
  const lifecycle = manifest.lifecycle || {}
  const evidence = manifest.evidence || {}
  require(object(integration), 'integration must be an object')
  require(typeof integration.protocol === 'string' && EXTENSION_ID_RE.test(integration.protocol), 'integration protocol id is invalid')
  require(typeof integration.artifact === 'string' && PATH_RE.test(integration.artifact), 'integration.artifact must be a safe repository path')
  require(object(install), 'install must be an object')
  require(MODES.has(install.mode), 'unsupported install mode')
  require(typeof install.adapter === 'string' && EXTENSION_ID_RE.test(install.adapter), 'install adapter id is invalid')
  require(FAILURE_POLICIES.has(install.failurePolicy), 'unsupported failure policy')
  require(typeof install.touchesCurrentBeforeActivation === 'boolean', 'touchesCurrentBeforeActivation must be boolean')
  require(object(lifecycle), 'lifecycle must be an object')
  require(ACTIVATIONS.has(lifecycle.activation), 'unsupported lifecycle activation')
  require(DISPOSE.has(lifecycle.dispose), 'unsupported lifecycle dispose fact')
  require(uniqueStrings(manifest.permissions) && manifest.permissions.every((value) => PERMISSION_RE.test(value)), 'permissions must be unique scope:access values')
  if (manifest.compatibility !== undefined) {
    require(object(manifest.compatibility), 'compatibility must be an object')
    require(uniqueStrings(manifest.compatibility?.dshVersions)
      && manifest.compatibility.dshVersions.length > 0
      && manifest.compatibility.dshVersions.every((value) => SEMVER_RE.test(value)), 'compatibility.dshVersions must contain unique exact versions')
    require(object(manifest.compatibility)
      && Object.keys(manifest.compatibility).every((key) => key === 'dshVersions'), 'compatibility contains unsupported fields')
  }
  if (manifest.capability !== undefined) {
    const capability = manifest.capability || {}
    require(object(capability), 'capability must be an object')
    require(typeof capability.id === 'string' && CAPABILITY_ID_RE.test(capability.id), 'capability.id is invalid')
    require(CAPABILITY_KINDS.has(capability.kind), 'capability.kind is invalid')
    require(typeof capability.invocation === 'string' && capability.invocation.length > 0, 'capability.invocation is required')
    require(typeof capability.expected === 'string' && capability.expected.length > 0, 'capability.expected is required')
  }
  if (!STATIC_PROTOCOLS.has(integration.protocol)) require(object(manifest.capability), `${integration.protocol} requires a named capability target`)
  else require(manifest.capability === undefined, `${integration.protocol} cannot declare a runtime capability target`)
  require(object(evidence), 'evidence must be an object')
  for (const name of ['install', 'failureIsolation', 'hotReload', 'remove']) {
    require(Object.hasOwn(evidence, name) && pathOrNull(evidence[name]), `evidence.${name} must be null or a safe repository path`)
  }

  if (install.mode === 'transactional') {
    require(install.failurePolicy === 'generation-rollback', 'transactional mode requires generation-rollback')
    require(install.touchesCurrentBeforeActivation === false, 'transactional mode must not touch current before activation')
  }
  if (install.mode === 'isolated-trial') {
    require(['discard-candidate', 'discard-process'].includes(install.failurePolicy), 'isolated-trial requires a discard failure policy')
    require(install.touchesCurrentBeforeActivation === false, 'isolated-trial must not touch current before activation')
  }
  if (install.mode === 'guided') require(install.failurePolicy === 'manual', 'guided mode requires manual failure policy')
  if (lifecycle.activation === 'hot-reload') require(lifecycle.dispose === 'supported', 'hot-reload requires a dispose hook')
  const builtinPair = BUILTIN_PROTOCOL_ADAPTERS[integration.protocol]
  if (builtinPair) require(builtinPair.includes(install.adapter), 'install adapter does not match the integration protocol')
  else require(!BUILTIN_ADAPTERS.has(install.adapter), 'a custom protocol cannot repurpose a built-in install adapter')

  if (integration.protocol === 'mcp') {
    const mcp = integration.mcp || {}
    require(object(integration.mcp), 'MCP integration requires integration.mcp')
    require(uniqueStrings(mcp.protocolVersions) && mcp.protocolVersions.every((value) => MCP_VERSION_RE.test(value)), 'MCP protocolVersions must be unique date versions')
    require(mcp.protocolVersions?.includes(MCP_PROTOCOL_CURRENT), `MCP integration must include current protocol ${MCP_PROTOCOL_CURRENT}`)
    require(typeof mcp.serverManifest === 'string' && PATH_RE.test(mcp.serverManifest), 'MCP serverManifest must be a safe repository path')
    require(mcp.serverManifest === integration.artifact, 'MCP artifact must be the official server manifest')
    require(mcp.registrySchema === MCP_REGISTRY_SCHEMA, 'MCP Registry schema is not current')
    if (manifest.testing !== undefined) {
      const testing = manifest.testing || {}
      require(object(testing), 'testing must be an object')
      require(typeof testing.entry === 'string' && PATH_RE.test(testing.entry) && /\.m?js$/.test(testing.entry), 'testing.entry must be a safe JavaScript module path')
      require(object(testing.arguments), 'testing.arguments must be an object')
      require(typeof testing.failureTool === 'string' && CAPABILITY_ID_RE.test(testing.failureTool), 'testing.failureTool is invalid')
      require(Object.keys(testing).every((key) => ['entry', 'arguments', 'failureTool'].includes(key)), 'testing contains unsupported fields')
    }
  } else {
    require(integration.mcp === undefined, 'integration.mcp is only valid for MCP')
    require(manifest.testing === undefined, 'testing is currently supported only for MCP')
  }
  return [...new Set(errors)]
}

export function validateOfficialMcpManifest({ packageJson, serverManifest, declaration }) {
  const errors = []
  if (!object(serverManifest)) return ['MCP server.json must be valid JSON']
  if (serverManifest.$schema !== MCP_REGISTRY_SCHEMA) errors.push('MCP server.json schema is not current')
  if (typeof serverManifest.name !== 'string' || !/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(serverManifest.name)) errors.push('MCP server name is invalid')
  if (!Array.isArray(serverManifest.packages) && !Array.isArray(serverManifest.remotes)) errors.push('MCP server.json must declare packages or remotes')
  const npmPackage = serverManifest.packages?.find((item) => item?.registryType === 'npm')
  if (npmPackage && packageJson?.mcpName !== serverManifest.name) errors.push('package.json#mcpName must match server.json#name')
  if (declaration?.integration?.mcp?.serverManifest !== declaration?.integration?.artifact) errors.push('MCP declaration must point to server.json as its artifact')
  return errors
}

export function capabilityProfile({ declaration = null, manifestSource = 'legacy-file-evidence', integrationProtocol = 'third-party', verificationState = 'untested', registryState = 'ineligible' } = {}) {
  const verified = verificationState === 'current-baseline-passed' && registryState === 'admitted'
  if (!declaration) {
    const legacyAdapter = {
      'harness-profile': 'profile-bundle',
      'harness-repository': 'repository-plugin',
      mcp: 'mcp-server',
      skill: 'skill',
      'harness-cordis': 'third-party',
      'third-party': 'third-party',
    }[integrationProtocol] || 'third-party'
    return {
      manifest: { status: 'legacy-evidence', source: manifestSource, schema: null },
      install: {
        mode: 'guided',
        adapter: legacyAdapter,
        seamless: { state: 'unknown', reason: 'current-baseline-lifecycle-not-verified' },
        failureIsolation: { state: 'unknown', policy: 'manual', reason: 'isolation-not-declared' },
      },
      lifecycle: { hotReload: { state: 'unknown', activation: 'unknown', reason: 'lifecycle-not-declared' } },
      integration: { protocol: integrationProtocol, artifact: manifestSource, mcp: null },
      admission: { route: 'legacy-compatibility-map', state: 'needs-package-manifest' },
    }
  }
  const install = declaration.install
  const lifecycle = declaration.lifecycle
  const seamlessDeclared = install.mode === 'transactional'
  const isolatedDeclared = install.touchesCurrentBeforeActivation === false
    && ['generation-rollback', 'discard-candidate', 'discard-process'].includes(install.failurePolicy)
  const hotReloadDeclared = lifecycle.activation === 'hot-reload' && lifecycle.dispose === 'supported'
  return {
    manifest: { status: 'valid', source: 'package.json#dshWorkshop', schema: declaration.schema },
    install: {
      mode: install.mode,
      adapter: install.adapter,
      seamless: {
        state: verified && seamlessDeclared ? 'verified' : seamlessDeclared ? 'declared' : 'unsupported',
        reason: verified && seamlessDeclared ? 'current-baseline-lifecycle-passed' : seamlessDeclared ? 'awaiting-current-baseline-test' : 'not-declared-transactional',
      },
      failureIsolation: {
        state: verified && isolatedDeclared ? 'verified' : isolatedDeclared ? 'declared' : 'unsupported',
        policy: install.failurePolicy,
        reason: verified && isolatedDeclared ? 'current-profile-protected-in-test' : isolatedDeclared ? 'awaiting-failure-injection-test' : 'current-may-be-touched',
      },
    },
    lifecycle: {
      hotReload: {
        state: verified && hotReloadDeclared ? 'verified' : hotReloadDeclared ? 'declared' : 'unsupported',
        activation: lifecycle.activation,
        reason: verified && hotReloadDeclared ? 'dispose-and-reactivate-passed' : hotReloadDeclared ? 'awaiting-hot-reload-test' : 'restart-or-unsupported',
      },
    },
    integration: {
      protocol: declaration.integration.protocol,
      artifact: declaration.integration.artifact,
      mcp: declaration.integration.mcp ? {
        protocolVersions: declaration.integration.mcp.protocolVersions,
        currentProtocol: MCP_PROTOCOL_CURRENT,
        registrySchema: declaration.integration.mcp.registrySchema,
      } : null,
    },
    admission: { route: 'package-json-manifest', state: verified ? 'registry-admitted' : 'manifest-ready-for-tests' },
  }
}
