import assert from 'node:assert/strict'
import test from 'node:test'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  isRetiredRepositoryOwner,
  packageDependencyEvidence,
  repositoryCreationPolicy,
} from '../scripts/topic-admission-policy.mjs'

test('community creation window is inclusive and fails closed', () => {
  assert.equal(repositoryCreationPolicy({ owner: 'community', createdAt: '2026-07-30T23:59:59Z' }).eligible, false)
  assert.equal(repositoryCreationPolicy({ owner: 'community', createdAt: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF }).eligible, true)
  assert.equal(repositoryCreationPolicy({ owner: 'community', createdAt: '2026-08-14T00:00:00Z' }).eligible, true)
  assert.deepEqual(repositoryCreationPolicy({ owner: 'community' }), {
    cutoff: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
    createdAt: null,
    officialExempt: false,
    eligible: false,
    reason: 'repository-created-at-unavailable',
  })
})

test('official owner exemption is identity based rather than text based', () => {
  const official = repositoryCreationPolicy({ owner: 'deepseek-ai', createdAt: '2025-01-01T00:00:00Z' })
  assert.equal(official.officialExempt, true)
  assert.equal(official.eligible, true)
  const spoofed = repositoryCreationPolicy({ owner: 'someone-else', name: 'official-dsh-plugin', description: 'official' })
  assert.equal(spoofed.officialExempt, false)
  assert.equal(spoofed.eligible, false)
})

test('retired source-owner exclusion is identity based', () => {
  assert.equal(isRetiredRepositoryOwner({ owner: 'dsh-external' }), true)
  assert.equal(isRetiredRepositoryOwner({ owner: { login: 'dsh-external' } }), true)
  assert.equal(isRetiredRepositoryOwner({ owner: 'someone-else', description: 'dsh-external' }), false)
})

test('only production, peer, and optional DSH dependencies qualify as runtime evidence', () => {
  const evidence = packageDependencyEvidence({
    dependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' },
    peerDependencies: { '@deepseek-ai/dsh-runtime': '^0.1.0' },
    optionalDependencies: { '@deepseek-ai/dsh-extra': '1.0.0' },
    devDependencies: { '@deepseek-ai/dsh-test': '1.0.0', unrelated: '1.0.0' },
  })
  assert.deepEqual(Object.keys(evidence.production).sort(), [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-extra',
    '@deepseek-ai/dsh-runtime',
  ])
  assert.deepEqual(Object.keys(evidence.versionedProduction).sort(), [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-extra',
    '@deepseek-ai/dsh-runtime',
  ])
  assert.deepEqual(evidence.unboundedProduction, {})
  assert.deepEqual(evidence.developmentOnly, { '@deepseek-ai/dsh-test': '1.0.0' })
  assert.equal(evidence.hasProductionHarnessDependency, true)
  assert.equal(evidence.hasVersionedProductionHarnessDependency, true)
  assert.equal(evidence.developmentOnlyDoesNotQualify, true)

  const developmentOnly = packageDependencyEvidence({ devDependencies: { '@deepseek-ai/dsh': '0.1.0-rc.6' } })
  assert.equal(developmentOnly.hasProductionHarnessDependency, false)
  assert.equal(developmentOnly.hasVersionedProductionHarnessDependency, false)
  assert.equal(developmentOnly.developmentOnlyDoesNotQualify, true)

  const wildcard = packageDependencyEvidence({ peerDependencies: { '@deepseek-ai/dsh': '*' } })
  assert.equal(wildcard.hasProductionHarnessDependency, true)
  assert.equal(wildcard.hasVersionedProductionHarnessDependency, false)
  assert.deepEqual(wildcard.unboundedProduction, { '@deepseek-ai/dsh': '*' })
})
