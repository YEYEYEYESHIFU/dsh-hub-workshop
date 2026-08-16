import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveLoaderAdapter, validateLoaderAdapterRegistry } from '../scripts/loader-adapter-lib.mjs'

const registry = JSON.parse(await readFile(new URL('../loader-adapters.json', import.meta.url), 'utf8'))

test('loader adapter registry has one fail-closed binding per integration pair', () => {
  assert.deepEqual(validateLoaderAdapterRegistry(registry), [])
  assert.equal(resolveLoaderAdapter(registry, {
    installAdapter: 'profile-bundle',
    protocol: 'harness-profile'
  }).id, 'official-profile')
  assert.equal(resolveLoaderAdapter(registry, {
    installAdapter: 'repository-plugin',
    protocol: 'harness-repository'
  }).authority, 'blocked')
})

test('duplicate loader bindings and incomplete Registry lifecycles are rejected', () => {
  const invalid = structuredClone(registry)
  invalid.adapters.push(structuredClone(invalid.adapters[0]))
  invalid.adapters.at(-1).id = 'duplicate-profile'
  invalid.adapters[0].lifecycle = ['inspect', 'cleanup']
  const errors = validateLoaderAdapterRegistry(invalid).join('; ')
  assert.match(errors, /duplicate loader binding/)
  assert.match(errors, /lacks install-candidate/)
})

test('a namespaced loader is added through the registry rather than a core enum', () => {
  const extended = structuredClone(registry)
  const adapter = structuredClone(extended.adapters[1])
  adapter.id = 'mygo-contract'
  adapter.match = { installAdapter: 'dev.omdsh.mygo-loader', protocol: 'dev.omdsh.mygo-v1' }
  extended.adapters.push(adapter)
  assert.deepEqual(validateLoaderAdapterRegistry(extended), [])
  assert.equal(resolveLoaderAdapter(extended, adapter.match).id, 'mygo-contract')
  assert.throws(() => resolveLoaderAdapter(registry, adapter.match), /received 0/)

  adapter.authority = 'registry-eligible-after-evidence'
  adapter.lifecycle = structuredClone(registry.adapters[0].lifecycle)
  assert.match(validateLoaderAdapterRegistry(extended).join('; '), /Registry v1 authority is limited/)
})
