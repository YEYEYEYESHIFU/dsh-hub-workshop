function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function exactPackage(name, version, fetchImpl) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'omdsh-hub-version-matrix/1.0' }
  })
  if (!response.ok) throw new Error(`${name}@${version}: npm HTTP ${response.status}`)
  const metadata = await response.json()
  assert(metadata.name === name && metadata.version === version, `${name}@${version}: npm returned different coordinates`)
  assert(typeof metadata.dist?.integrity === 'string' && metadata.dist.integrity.startsWith('sha512-'), `${name}@${version}: sha512 integrity is missing`)
  return { package: name, version, integrity: metadata.dist.integrity }
}

export async function resolveDshBaseline(version, currentBaseline, { fetchImpl = fetch } = {}) {
  if (version === currentBaseline.runtime.version) return structuredClone(currentBaseline)
  assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(version), 'DSH matrix version must be exact semver')
  const [runtime, base, web] = await Promise.all([
    exactPackage('@deepseek-ai/dsh', version, fetchImpl),
    exactPackage('@deepseek-ai/dsh-base', version, fetchImpl),
    exactPackage('@deepseek-ai/dsh-web-app', version, fetchImpl)
  ])
  const baseline = structuredClone(currentBaseline)
  baseline.checkedAt = new Date().toISOString()
  baseline.runtime = {
    ...baseline.runtime,
    version,
    distTag: 'declared-exact',
    releaseChannel: version.includes('-') ? 'release-candidate' : 'stable',
    ga: !version.includes('-'),
    integrity: runtime.integrity
  }
  baseline.contracts.profileBundle.templates.base.exactPackages = [base]
  baseline.contracts.profileBundle.templates.web.exactPackages = [base, web]
  return baseline
}
