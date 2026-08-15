export const COMMUNITY_PLUGIN_CREATED_AT_CUTOFF = '2026-07-31T00:00:00.000Z'

// Official status is identity-based, never inferred from a repository name,
// description, README, Topic, or popularity. Community organization projects
// must pass the same creation window as every other community repository.
export const OFFICIAL_REPOSITORY_OWNERS = Object.freeze(['deepseek-ai'])
export const RETIRED_REPOSITORY_OWNERS = Object.freeze(['dsh-external'])

const officialOwners = new Set(OFFICIAL_REPOSITORY_OWNERS)
const retiredOwners = new Set(RETIRED_REPOSITORY_OWNERS)

function validDateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function repositoryCreationPolicy(repository) {
  const ownerValue = typeof repository?.owner === 'string' ? repository.owner : repository?.owner?.login
  const owner = String(ownerValue || '').toLocaleLowerCase('en-US')
  const createdAt = validDateTime(repository?.createdAt)
    ? new Date(repository.createdAt).toISOString()
    : validDateTime(repository?.created_at)
      ? new Date(repository.created_at).toISOString()
      : null
  const officialExempt = officialOwners.has(owner)
  const eligible = officialExempt
    || (createdAt !== null && Date.parse(createdAt) >= Date.parse(COMMUNITY_PLUGIN_CREATED_AT_CUTOFF))
  const reason = officialExempt
    ? 'official-owner-exempt'
    : createdAt === null
      ? 'repository-created-at-unavailable'
      : eligible
        ? 'community-repository-created-in-window'
        : 'community-repository-created-before-cutoff'

  return {
    cutoff: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
    createdAt,
    officialExempt,
    eligible,
    reason,
  }
}

export function isRetiredRepositoryOwner(repository) {
  const ownerValue = typeof repository?.owner === 'string' ? repository.owner : repository?.owner?.login
  return retiredOwners.has(String(ownerValue || '').toLocaleLowerCase('en-US'))
}

export function packageDependencyEvidence(packageJson) {
  const sections = ['dependencies', 'peerDependencies', 'optionalDependencies']
  const production = Object.fromEntries(sections.flatMap((section) => Object.entries(packageJson?.[section] || {})))
  const development = { ...(packageJson?.devDependencies || {}) }
  const isHarnessPackage = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
  const harnessProduction = Object.fromEntries(Object.entries(production).filter(([name]) => isHarnessPackage(name)))
  const versionedProduction = Object.fromEntries(Object.entries(harnessProduction).filter(([, spec]) => (
    typeof spec === 'string'
    && /\d/.test(spec)
    && !/^\s*(?:\*|latest|workspace:|file:|link:|git\+|https?:)/i.test(spec)
  )))
  const unboundedProduction = Object.fromEntries(Object.entries(harnessProduction)
    .filter(([name]) => !Object.hasOwn(versionedProduction, name)))
  const harnessDevelopmentOnly = Object.fromEntries(Object.entries(development)
    .filter(([name]) => isHarnessPackage(name) && !Object.hasOwn(production, name)))

  return {
    source: packageJson ? 'package.json' : null,
    production: harnessProduction,
    versionedProduction,
    unboundedProduction,
    developmentOnly: harnessDevelopmentOnly,
    hasProductionHarnessDependency: Object.keys(harnessProduction).length > 0,
    hasVersionedProductionHarnessDependency: Object.keys(versionedProduction).length > 0,
    developmentOnlyDoesNotQualify: Object.keys(harnessDevelopmentOnly).length > 0,
  }
}
