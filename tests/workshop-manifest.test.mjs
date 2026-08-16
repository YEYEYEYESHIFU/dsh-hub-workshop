import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MCP_PROTOCOL_CURRENT,
  MCP_REGISTRY_SCHEMA,
  capabilityProfile,
  validateOfficialMcpManifest,
  validateWorkshopManifest,
} from '../scripts/workshop-manifest-lib.mjs'

function profileManifest() {
  return {
    schema: 'omdsh-workshop-package/v1',
    type: 'plugin',
    integration: { protocol: 'harness-profile', artifact: 'package.json' },
    install: {
      mode: 'transactional',
      adapter: 'profile-bundle',
      failurePolicy: 'generation-rollback',
      touchesCurrentBeforeActivation: false,
    },
    lifecycle: { activation: 'restart-profile', dispose: 'supported' },
    permissions: ['filesystem:read'],
    capability: {
      id: 'profile-route-ready',
      kind: 'service',
      invocation: 'boot the candidate Profile and request the declared route',
      expected: 'the declared route returns a deterministic response',
    },
    evidence: {
      install: 'docs/verification/install.md',
      failureIsolation: 'docs/verification/failure.md',
      hotReload: null,
      remove: 'docs/verification/remove.md',
    },
  }
}

test('accepts a transactional package.json Workshop declaration', () => {
  assert.deepEqual(validateWorkshopManifest(profileManifest()), [])
})

test('rejects transactional declarations that can touch current before activation', () => {
  const manifest = profileManifest()
  manifest.install.touchesCurrentBeforeActivation = true
  assert.match(validateWorkshopManifest(manifest).join('\n'), /must not touch current/)
})

test('requires hot reload to expose a dispose hook', () => {
  const manifest = profileManifest()
  manifest.lifecycle = { activation: 'hot-reload', dispose: 'unknown' }
  assert.match(validateWorkshopManifest(manifest).join('\n'), /dispose hook/)
})

test('aligns MCP declarations with the current official protocol and server manifest', () => {
  const declaration = {
    schema: 'omdsh-workshop-package/v1',
    type: 'plugin',
    integration: {
      protocol: 'mcp',
      artifact: 'server.json',
      mcp: {
        protocolVersions: [MCP_PROTOCOL_CURRENT],
        serverManifest: 'server.json',
        registrySchema: MCP_REGISTRY_SCHEMA,
      },
    },
    install: { mode: 'isolated-trial', adapter: 'mcp-server', failurePolicy: 'discard-process', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'restart-plugin', dispose: 'supported' },
    permissions: ['network:outbound'],
    capability: {
      id: 'weather-current',
      kind: 'tool',
      invocation: 'tools/call weather-current with a fixed city',
      expected: 'a structured current-weather response',
    },
    evidence: { install: null, failureIsolation: null, hotReload: null, remove: null },
  }
  assert.deepEqual(validateWorkshopManifest(declaration), [])
  assert.deepEqual(validateOfficialMcpManifest({
    packageJson: { name: '@owner/weather', mcpName: 'io.github.owner/weather' },
    serverManifest: {
      $schema: MCP_REGISTRY_SCHEMA,
      name: 'io.github.owner/weather',
      packages: [{ registryType: 'npm', identifier: '@owner/weather', version: '1.0.0', transport: { type: 'stdio' } }],
    },
    declaration,
  }), [])
})

test('accepts underscore capability ids exposed by MCP tools/list', () => {
  const declaration = {
    schema: 'omdsh-workshop-package/v1',
    type: 'plugin',
    integration: {
      protocol: 'mcp',
      artifact: 'server.json',
      mcp: {
        protocolVersions: [MCP_PROTOCOL_CURRENT],
        serverManifest: 'server.json',
        registrySchema: MCP_REGISTRY_SCHEMA,
      },
    },
    install: { mode: 'isolated-trial', adapter: 'mcp-server', failurePolicy: 'discard-process', touchesCurrentBeforeActivation: false },
    lifecycle: { activation: 'restart-plugin', dispose: 'supported' },
    permissions: [],
    capability: { id: 'color_search', kind: 'tool', invocation: 'tools/call color_search', expected: 'a deterministic color response' },
    evidence: { install: null, failureIsolation: null, hotReload: null, remove: null },
  }
  assert.deepEqual(validateWorkshopManifest(declaration), [])
})

test('rejects an npm MCP ownership mismatch', () => {
  const errors = validateOfficialMcpManifest({
    packageJson: { mcpName: 'io.github.owner/other' },
    serverManifest: {
      $schema: MCP_REGISTRY_SCHEMA,
      name: 'io.github.owner/weather',
      packages: [{ registryType: 'npm', identifier: '@owner/weather' }],
    },
  })
  assert.match(errors.join('\n'), /mcpName/)
})

test('requires a capability target for executable protocols and forbids one for static-only guidance', () => {
  const executable = profileManifest()
  delete executable.capability
  assert.match(validateWorkshopManifest(executable).join('\n'), /requires a named capability target/)

  const staticOnly = profileManifest()
  staticOnly.integration = { protocol: 'skill', artifact: 'SKILL.md' }
  staticOnly.install = { mode: 'guided', adapter: 'skill', failurePolicy: 'manual', touchesCurrentBeforeActivation: false }
  assert.match(validateWorkshopManifest(staticOnly).join('\n'), /cannot declare a runtime capability target/)
})

test('accepts a namespaced loader contract without teaching the manifest core its name', () => {
  const manifest = profileManifest()
  manifest.integration.protocol = 'dev.omdsh.mygo-v1'
  manifest.install.adapter = 'dev.omdsh.mygo-loader'
  manifest.install.mode = 'isolated-trial'
  manifest.install.failurePolicy = 'discard-process'
  manifest.lifecycle.activation = 'restart-plugin'
  assert.deepEqual(validateWorkshopManifest(manifest), [])

  manifest.install.adapter = 'profile-bundle'
  assert.match(validateWorkshopManifest(manifest).join('\n'), /cannot repurpose a built-in/)
})

test('keeps author capability declarations separate from current-baseline verification', () => {
  const profile = capabilityProfile({ declaration: profileManifest() })
  assert.equal(profile.install.seamless.state, 'declared')
  assert.equal(profile.install.failureIsolation.state, 'declared')
  assert.equal(profile.lifecycle.hotReload.state, 'unsupported')
  assert.equal(profile.admission.state, 'manifest-ready-for-tests')
})

test('legacy evidence exposes its detected DSH adapter without granting installation authority', () => {
  const profile = capabilityProfile({
    manifestSource: 'resolved bundle patch:cordis.patch.yml',
    integrationProtocol: 'harness-profile',
  })
  assert.equal(profile.install.mode, 'guided')
  assert.equal(profile.install.adapter, 'profile-bundle')
  assert.equal(profile.admission.state, 'needs-package-manifest')
})
