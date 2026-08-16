import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ID_RE = /^[a-z0-9][a-z0-9.-]*$/
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const MODULE_RE = /^scripts\/loader-adapters\/[a-z0-9-]+\.mjs$/
const EXECUTION = new Set(['static', 'trusted-ephemeral'])
const AUTHORITY = new Set(['registry-eligible-after-evidence', 'catalog-only', 'blocked'])

function contained(root, target) {
  const child = relative(resolve(root), resolve(target))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export function validateLoaderAdapterRegistry(registry) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(registry?.schema === 'omdsh-loader-adapter-registry/v1', 'unsupported loader adapter registry')
  require(Array.isArray(registry?.adapters), 'loader adapter registry must contain adapters')
  const ids = new Set()
  const bindings = new Set()
  for (const adapter of registry?.adapters || []) {
    require(ID_RE.test(adapter?.id || ''), 'loader adapter id is invalid')
    require(!ids.has(adapter?.id), `duplicate loader adapter id: ${adapter?.id}`)
    ids.add(adapter?.id)
    require(VERSION_RE.test(adapter?.version || ''), `${adapter?.id}: version must be exact semver`)
    const binding = `${adapter?.match?.installAdapter}:${adapter?.match?.protocol}`
    require(ID_RE.test(adapter?.match?.installAdapter || '') && adapter.match.installAdapter.length <= 128, `${adapter?.id}: install adapter binding is invalid`)
    require(ID_RE.test(adapter?.match?.protocol || '') && adapter.match.protocol.length <= 128, `${adapter?.id}: protocol binding is invalid`)
    require(!bindings.has(binding), `duplicate loader binding: ${binding}`)
    bindings.add(binding)
    require(EXECUTION.has(adapter?.execution), `${adapter?.id}: unsupported execution boundary`)
    require(AUTHORITY.has(adapter?.authority), `${adapter?.id}: unsupported authority`)
    require(Array.isArray(adapter?.lifecycle) && new Set(adapter.lifecycle).size === adapter.lifecycle.length, `${adapter?.id}: lifecycle must be unique`)
    if (adapter?.implementation?.type === 'bundled-module') {
      require(MODULE_RE.test(adapter.implementation.module || ''), `${adapter.id}: bundled module path is unsafe`)
      require(adapter.implementation.export === 'createAdapter', `${adapter.id}: unsupported module export`)
    } else {
      require(adapter?.implementation?.type === 'unavailable' && typeof adapter.implementation.reason === 'string', `${adapter?.id}: unsupported implementation`)
    }
    if (adapter?.authority === 'registry-eligible-after-evidence') {
      require(adapter?.match?.installAdapter === 'profile-bundle' && adapter?.match?.protocol === 'harness-profile', `${adapter.id}: Registry v1 authority is limited to the official Profile Bundle boundary`)
      for (const phase of ['install-candidate', 'ready', 'invoke', 'inject-failure', 'update', 'remove', 'rollback', 'cleanup']) {
        require(adapter.lifecycle?.includes(phase), `${adapter.id}: Registry-capable adapter lacks ${phase}`)
      }
    }
  }
  return [...new Set(errors)]
}

export function resolveLoaderAdapter(registry, { installAdapter, protocol }) {
  const errors = validateLoaderAdapterRegistry(registry)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const matches = registry.adapters.filter((adapter) => adapter.match.installAdapter === installAdapter
    && adapter.match.protocol === protocol)
  if (matches.length !== 1) throw new Error(`expected one loader adapter for ${installAdapter}/${protocol}, received ${matches.length}`)
  return matches[0]
}

export async function loadLoaderAdapter({ root, registry, installAdapter, protocol, context }) {
  const descriptor = resolveLoaderAdapter(registry, { installAdapter, protocol })
  if (descriptor.implementation.type !== 'bundled-module') {
    throw new Error(`${descriptor.id} is unavailable: ${descriptor.implementation.reason}`)
  }
  const modulePath = resolve(root, descriptor.implementation.module)
  const allowedRoot = resolve(root, 'scripts/loader-adapters')
  if (!contained(allowedRoot, modulePath)) throw new Error(`${descriptor.id}: adapter module escapes the trusted adapter directory`)
  const module = await import(pathToFileURL(modulePath))
  const factory = module[descriptor.implementation.export]
  if (typeof factory !== 'function') throw new Error(`${descriptor.id}: adapter factory is missing`)
  const adapter = await factory({ ...context, descriptor })
  if (!adapter || typeof adapter.run !== 'function' || typeof adapter.cleanup !== 'function') {
    throw new Error(`${descriptor.id}: adapter does not implement run and cleanup`)
  }
  return { descriptor, adapter }
}

export async function readLoaderAdapterRegistry(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
