import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('market layers classify infrastructure and distributions separately from plugins', async () => {
  const layers = await json('market-layers.json')
  assert.equal(layers.schema, 'omdsh-market-layers/v2')
  assert.equal(layers.projects.length, layers.totals.projects)
  assert.equal(layers.projects.filter((project) => project.layer === 'infrastructure').length, layers.totals.infrastructure)
  assert.equal(layers.projects.filter((project) => project.layer === 'distribution').length, layers.totals.distribution)
  assert.ok(layers.projects.filter((project) => project.review.state === 'curated').every((project) => /^[0-9a-f]{40}$/.test(project.source.ref)))
  assert.ok(layers.projects.filter((project) => project.review.state === 'pending-review').every((project) => project.verification.state === 'unverified'))
  assert.ok(layers.projects.every((project) => project.registry.state === 'ineligible'))
})

test('dsh-mygo is visible as infrastructure but excluded from plugin installation authorities', async () => {
  const [layers, catalog, inventory, registry] = await Promise.all([
    json('market-layers.json'),
    json('catalog.json'),
    json('verification-inventory.json'),
    json('registry-v1.json'),
  ])
  const project = layers.projects.find((entry) => entry.id === 'omdsh-dev/dsh-mygo')
  assert.equal(project?.layer, 'infrastructure')
  assert.equal(project?.review.reason, 'ecosystem-infrastructure')
  for (const authority of [catalog.packages, inventory.projects, registry.entries]) {
    assert.equal(authority.some((entry) => entry.id === project.id), false)
  }
})

test('unverified ecosystem claims stay out of public market layers', async () => {
  const [layers, audit] = await Promise.all([json('market-layers.json'), json('topic-plugin-audit.json')])
  assert.equal(layers.projects.some((entry) => entry.id === 'bruc3van/dsh-desktop'), false)
  assert.equal(layers.projects.some((entry) => entry.id === 'jesse-njx/dsh-plugin-manager'), false)
  assert.equal(audit.repositories.find((entry) => entry.owner === 'bruc3van' && entry.name === 'dsh-desktop')?.reasonCode, 'infrastructure-needs-source-evidence')
  assert.ok(layers.projects.every((entry) => entry.registry.state === 'ineligible'))
})
