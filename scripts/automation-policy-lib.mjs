import { resolveLoaderAdapter } from './loader-adapter-lib.mjs'

const EXACT_DSH_RE = /@deepseek-ai\/dsh@((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)/g

function unique(values) {
  return [...new Set(values)]
}

export function validateAutomationPolicy(policy) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(policy?.schema === 'omdsh-hub-automation-policy/v1', 'unsupported automation policy')
  require(policy?.discovery?.topic === 'dsh-plugin', 'discovery topic must be dsh-plugin')
  require(policy?.discovery?.autoAdmission === false, 'Topic discovery must never auto-admit')
  require(policy?.verification?.unexpectedSkips === 'fail', 'unexpected Harness skips must fail')
  require(policy?.verification?.installScripts === 'disabled', 'install scripts must remain disabled')
  require(policy?.trust?.environment === 'admission', 'trusted execution must use the admission environment')
  require(policy?.release?.registrySignature === 'Ed25519', 'Registry releases must use Ed25519')
  require(policy?.release?.productionApproval === true, 'production must retain an approval gate')
  return errors
}

export function declaredDshVersions(record) {
  const structured = record?.submission?.manifest?.packageManifest?.compatibility?.dshVersions
  if (Array.isArray(structured)) return unique(structured)
  const text = String(record?.submission?.manifest?.release?.compatibility || '')
  return unique([...text.matchAll(EXACT_DSH_RE)].map((match) => match[1]))
}

export function buildVerificationJobs(record, baseline, policy, loaderRegistry) {
  const errors = validateAutomationPolicy(policy)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const manifest = record?.submission?.manifest
  const declaration = manifest?.packageManifest
  const adapter = declaration?.install?.adapter
  const protocol = declaration?.integration?.protocol || manifest?.management?.protocol
  if (!adapter) return { jobs: [], blocked: ['package.json#dshWorkshop install adapter is required'] }
  if (!loaderRegistry) return { jobs: [], blocked: ['trusted loader adapter registry is required'] }
  let descriptor
  try {
    descriptor = resolveLoaderAdapter(loaderRegistry, { installAdapter: adapter, protocol })
  } catch (error) {
    return { jobs: [], blocked: [error.message] }
  }
  if (descriptor.implementation.type === 'unavailable' || descriptor.authority === 'blocked') {
    return { jobs: [], blocked: [`${descriptor.id} is unavailable: ${descriptor.implementation.reason || 'adapter authority is blocked'}`] }
  }

  const current = baseline.runtime.version
  const versions = descriptor.execution === 'trusted-ephemeral'
    ? unique([...declaredDshVersions(record), current])
    : [current]
  const requiresTrust = descriptor.execution === 'trusted-ephemeral'
  const jobs = versions.map((version) => ({
    key: `${record.id}-${adapter}-${version}`.replace(/[^A-Za-z0-9._-]/g, '-'),
    releaseId: record.id,
    adapter,
    loaderAdapter: descriptor.id,
    loaderAdapterVersion: descriptor.version,
    protocol,
    runtimeVersion: version,
    authority: version === current ? 'current-baseline' : 'compatibility-only',
    runner: requiresTrust ? 'macos-15' : 'ubuntu-24.04',
    requiresTrust,
    registryAuthority: descriptor.authority
  }))
  const blocked = []
  if (adapter === 'mcp-server' && !declaration?.testing?.entry) {
    blocked.push('MCP automation requires package.json#dshWorkshop.testing.entry')
  }
  return { jobs: blocked.length ? [] : jobs, blocked }
}

export function buildAutomationPlan(records, baseline, policy, loaderRegistry, releaseSelection = null) {
  const releaseIds = releaseSelection === null
    ? null
    : new Set(Array.isArray(releaseSelection) ? releaseSelection : [releaseSelection])
  const selected = releaseIds ? records.filter((record) => releaseIds.has(record.id)) : records
  const missing = releaseIds ? [...releaseIds].filter((releaseId) => !selected.some((record) => record.id === releaseId)) : []
  if (missing.length > 0) throw new Error(`unknown Intake release: ${missing.join(', ')}`)
  const jobs = []
  const blocked = []
  for (const record of selected) {
    const result = buildVerificationJobs(record, baseline, policy, loaderRegistry)
    jobs.push(...result.jobs)
    blocked.push(...result.blocked.map((reason) => ({ releaseId: record.id, reason })))
  }
  return {
    schema: 'omdsh-hub-automation-plan/v1',
    baseline: `${baseline.runtime.package}@${baseline.runtime.version}`,
    releaseIds: selected.map((record) => record.id),
    jobs,
    blocked,
    summary: {
      releases: selected.length,
      staticJobs: jobs.filter((job) => !job.requiresTrust).length,
      trustedJobs: jobs.filter((job) => job.requiresTrust).length,
      admissionEligible: jobs.some((job) => job.authority === 'current-baseline'
        && job.registryAuthority === 'registry-eligible-after-evidence'),
      blocked: blocked.length
    }
  }
}
