import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'
import { buildCatalogPresentation } from '../scripts/catalog-presentation-lib.mjs'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('plugin and market APIs are generated from separate authorities', async () => {
  await exec(process.execPath, ['scripts/build-plugin-api.mjs'], { cwd: root })
  const [catalog, inventory, layers, plugins, types, market] = await Promise.all([
    json('catalog.json'),
    json('verification-inventory.json'),
    json('market-layers.json'),
    json('api/v1/plugins.json'),
    json('api/v1/plugin-types.json'),
    json('api/v1/market.json'),
  ])
  const presentation = buildCatalogPresentation(catalog)
  assert.equal(plugins.count, presentation.listings.length)
  assert.equal(plugins.componentCount, catalog.packages.length)
  assert.equal(plugins.projects.length, presentation.listings.length)
  assert.equal(types.totals.catalogProjects, presentation.listings.length)
  assert.equal(types.totals.catalogComponents, catalog.packages.length)
  assert.deepEqual(
    Object.fromEntries(types.management.filter((entry) => entry.count > 0).map((entry) => [entry.id, entry.count])),
    inventory.summary.management,
  )
  assert.deepEqual(
    Object.fromEntries(types.reviewStates.filter((entry) => entry.count > 0).map((entry) => [entry.id, entry.count])),
    inventory.summary.review,
  )
  assert.equal(market.totals.projects, presentation.listings.length + layers.projects.length)
  assert.equal(market.totals.plugin, presentation.listings.length)
  assert.equal(market.totals.infrastructure, layers.totals.infrastructure)
  assert.equal(market.totals.distribution, layers.totals.distribution)
  assert.equal(market.totals.installable, 0)
})

test('Toybox is one public project with eight independently reviewable components', async () => {
  const [catalog, plugins, inventory] = await Promise.all([
    json('catalog.json'),
    json('api/v1/plugins.json'),
    json('verification-inventory.json'),
  ])
  const toyboxIds = new Set(catalog.presentationGroups.find((group) => group.id === 'toybox').componentIds)
  const toybox = plugins.projects.find((project) => project.id === 'toybox')
  assert.ok(toybox)
  assert.deepEqual(toybox.presentation.componentCounts, { mcp: 5, skill: 3 })
  assert.equal(toybox.presentation.components.length, 8)
  assert.deepEqual(new Set(toybox.presentation.components.map((component) => component.id)), toyboxIds)
  assert.equal(plugins.projects.some((project) => toyboxIds.has(project.id)), false)
  assert.equal(inventory.projects.filter((project) => toyboxIds.has(project.id)).length, 8)
  assert.ok(toybox.presentation.components.every((component) => component.registry.state === 'ineligible'))
})

test('read-only plugin API exposes no install command or executable package intent', async () => {
  const plugins = await json('api/v1/plugins.json')
  const serialized = JSON.stringify(plugins)
  for (const forbidden of ['installCommand', 'profileBundle', '@deepseek-ai/dsh-repository-plugin', '&path:/.dsh-plugin']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
  assert.ok(plugins.projects.every((project) => project.registry.state === 'ineligible'))
})

test('non-plugin market projects never leak into plugin or Registry authorities', async () => {
  const [catalog, inventory, layers, plugins, registry] = await Promise.all([
    json('catalog.json'),
    json('verification-inventory.json'),
    json('market-layers.json'),
    json('api/v1/plugins.json'),
    json('registry-v1.json'),
  ])
  const protectedIds = new Set(layers.projects.map((project) => project.id))
  for (const collection of [catalog.packages, inventory.projects, plugins.projects, registry.entries]) {
    assert.ok(collection.every((project) => !protectedIds.has(project.id)))
  }
  assert.ok(layers.projects.every((project) => project.registry.state === 'ineligible'))
})
