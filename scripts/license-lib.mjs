const SPDX_ID_RE = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|LicenseRef-[A-Za-z0-9.-]+)(?:\+)?$/

const PERMISSIVE = new Set([
  '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'ISC', 'MIT', 'MIT-0',
  'NCSA', 'PostgreSQL', 'Python-2.0', 'Zlib',
])
const PUBLIC_DOMAIN = new Set(['CC0-1.0', 'Unlicense'])
const WEAK_COPYLEFT = /^(?:EPL|LGPL|MPL|CDDL)-/
const COPYLEFT = /^(?:AGPL|GPL)-/
const UNKNOWN = new Set(['NOASSERTION', 'NONE', 'UNLICENSED'])

function simpleIds(expression) {
  return expression.replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .map((value) => value.trim()).filter(Boolean)
}

function parseExpression(expression) {
  const tokens = expression.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/g) || []
  let offset = 0
  function primary() {
    if (tokens[offset] === '(') {
      offset += 1
      disjunction()
      if (tokens[offset] !== ')') throw new Error('unclosed group')
      offset += 1
      return
    }
    const license = tokens[offset]
    if (!SPDX_ID_RE.test(license || '') || UNKNOWN.has(license)) throw new Error('license ID expected')
    offset += 1
    if (tokens[offset] === 'WITH') {
      offset += 1
      const exception = tokens[offset]
      if (!SPDX_ID_RE.test(exception || '') || UNKNOWN.has(exception) || exception.endsWith('+')) throw new Error('exception ID expected')
      offset += 1
    }
  }
  function conjunction() {
    primary()
    while (tokens[offset] === 'AND') { offset += 1; primary() }
  }
  function disjunction() {
    conjunction()
    while (tokens[offset] === 'OR') { offset += 1; conjunction() }
  }
  disjunction()
  if (offset !== tokens.length) throw new Error('unexpected token')
}

export function validateLicenseExpression(value) {
  if (typeof value !== 'string' || value.trim() === '') return ['license expression is required']
  const expression = value.trim()
  if (expression.length > 256) return ['license expression is too long']
  if (UNKNOWN.has(expression)) return []
  try {
    parseExpression(expression)
  } catch {
    return ['license must use an SPDX expression, LicenseRef, or NOASSERTION']
  }
  return []
}

export function licenseFacts(expression, source = 'registry') {
  const normalized = String(expression || 'NOASSERTION').trim() || 'NOASSERTION'
  const ids = simpleIds(normalized)
  const unknown = ids.length === 0 || ids.some((id) => UNKNOWN.has(id))
  const custom = ids.some((id) => id.startsWith('LicenseRef-'))
  let family = 'other'
  if (unknown) family = 'unknown'
  else if (custom) family = 'custom'
  else if (ids.some((id) => COPYLEFT.test(id))) family = 'copyleft'
  else if (ids.some((id) => WEAK_COPYLEFT.test(id))) family = 'weak-copyleft'
  else if (ids.every((id) => PERMISSIVE.has(id))) family = 'permissive'
  else if (ids.every((id) => PUBLIC_DOMAIN.has(id))) family = 'public-domain'
  const review = ['unknown', 'custom', 'other'].includes(family) ? 'required' : 'notice'
  const url = ids.length === 1 && !unknown && !custom
    ? `https://spdx.org/licenses/${encodeURIComponent(ids[0].replace(/\+$/, '-or-later'))}.html`
    : 'https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/'
  return { expression: normalized, family, review, source, url }
}

export function componentLicenseInventory(manifest, registry) {
  const entries = new Map((registry?.entries || []).map((entry) => [entry.id, entry]))
  return (manifest.items || []).map((item) => {
    if (item.type === 'source') {
      return {
        componentId: item.id,
        componentType: 'fixed-source',
        packageName: item.packageName,
        version: item.version,
        ...licenseFacts(item.license.expression, item.license.source),
      }
    }
    const entry = entries.get(item.projectId)
    const release = entry?.releases?.find((candidate) => candidate.id === item.releaseId)
    return {
      componentId: item.projectId,
      componentType: 'registry',
      packageName: release?.install?.packageName ?? entry?.install?.packageName ?? null,
      version: release?.version ?? item.releaseId?.split('@').at(-1) ?? null,
      ...licenseFacts(release?.license ?? entry?.license ?? 'NOASSERTION', 'registry'),
    }
  })
}
