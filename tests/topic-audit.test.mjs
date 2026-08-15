import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function json(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
}

test('topic audit stats match decisions and dsh-mygo cannot leak into plugin surfaces', async () => {
  const [audit, catalog, inventory, api] = await Promise.all([
    json('../topic-plugin-audit.json'),
    json('../catalog.json'),
    json('../verification-inventory.json'),
    json('../api/v1/plugins.json'),
  ])

  const decisions = Object.fromEntries(['exclude', 'include', 'market', 'review'].map((decision) => [
    decision,
    audit.repositories.filter((entry) => entry.decision === decision).length,
  ]).filter(([, count]) => count > 0))
  assert.deepEqual(audit.stats.decisions, decisions)
  const reasons = Object.fromEntries([...new Set(audit.repositories.map((entry) => entry.reasonCode))]
    .sort()
    .map((reason) => [reason, audit.repositories.filter((entry) => entry.reasonCode === reason).length]))
  assert.deepEqual(audit.stats.reasons, reasons)

  const candidate = audit.repositories.find((entry) => entry.owner === 'omdsh-dev' && entry.name === 'dsh-mygo')
  assert.equal(candidate.decision, 'market')
  assert.equal(candidate.marketLayer, 'infrastructure')
  assert.equal(candidate.reasonCode, 'ecosystem-infrastructure')
  assert.equal(candidate.evidence.manualReview.inspectedCommit, '4566748646823f8e2123f6addcf22b55e305e740')
  assert.equal(candidate.evidence.manualReview.verificationLevel, 'static-public-source')
  assert.ok(candidate.evidence.manualReview.findings.includes('root-package-manifest-absent'))
  assert.ok(candidate.evidence.manualReview.findings.includes('current-public-baseline-not-verified'))

  const catalogText = JSON.stringify({ packages: catalog.packages, plugins: catalog.plugins })
  assert.doesNotMatch(catalogText, /omdsh-dev\/dsh-mygo/)
  assert.equal(inventory.projects.some((entry) => entry.repository === 'https://github.com/omdsh-dev/dsh-mygo'), false)
  assert.equal(api.projects.some((entry) => entry.source?.repository === 'https://github.com/omdsh-dev/dsh-mygo'), false)

  const modlens = audit.repositories.find((entry) => entry.owner === 'liustack' && entry.name === 'modlens')
  assert.equal(modlens.decision, 'exclude')
  assert.equal(modlens.reasonCode, 'community-repository-created-before-cutoff')
  assert.equal(modlens.evidence.creation.eligible, false)
  const awesome = audit.repositories.find((entry) => entry.owner === '0xsline' && entry.name === 'awesome-deepseek-harness')
  assert.equal(awesome.decision, 'exclude')
  const core = audit.repositories.find((entry) => entry.owner === 'deepseek-ai' && entry.name === 'deepseek-harness')
  assert.equal(core.decision, 'exclude')

  const qualified = new Map(audit.repositories.filter((entry) => entry.decision === 'include').map((entry) => [entry.url, entry]))
  for (const entry of audit.repositories) {
    assert.ok(entry.evidence.creation)
    assert.equal(entry.evidence.creation.createdAt === null || Number.isFinite(Date.parse(entry.evidence.creation.createdAt)), true)
    if (entry.decision === 'include') assert.equal(entry.evidence.creation.eligible, true)
    if (['verified-plugin-contract', 'verified-harness-integration'].includes(entry.reasonCode)) {
      const repositoryPlugin = (entry.evidence.strongSignals || []).some((signal) => /\.dsh-plugin package and runtime asset/i.test(signal))
      if (!repositoryPlugin) {
        assert.equal(entry.evidence.dependencyCheck.hasVersionedProductionHarnessDependency, true)
        assert.equal(entry.evidence.dependencyCheck.linkedFromRuntimeOrManifest, true)
        assert.ok(entry.evidence.dependencyCheck.referencedProduction.length > 0)
      }
    }
  }
  assert.equal(audit.repositories.some((entry) => entry.decision === 'include'
    && ['missing-production-harness-dependency', 'unbounded-production-harness-dependency', 'unlinked-production-harness-dependency', 'static-extension-needs-workshop-manifest'].includes(entry.reasonCode)), false)
  for (const entry of catalog.packages.filter((entry) => entry.status === 'discovery')) {
    const evidence = qualified.get(entry.repository)
    assert.equal(evidence?.qualification, 'verified')
    assert.ok(evidence.evidence.strongSignals.length > 0)
    assert.equal(entry.discovery.creationEligibility === 'community-repository-created-in-window'
      || entry.discovery.creationEligibility === 'official-owner-exempt', true)
    assert.ok(Number.isFinite(Date.parse(entry.discovery.createdAt)))
  }
  assert.equal(catalog.packages.some((entry) => /pending-review/.test(entry.discovery?.qualification || '')), false)
})
