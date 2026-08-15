import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildCatalogPresentation } from '../scripts/catalog-presentation-lib.mjs'

const root = new URL('../', import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('presentation grouping changes public listings without changing component authority', async () => {
  const catalog = await json('catalog.json')
  const presentation = buildCatalogPresentation(catalog)
  const group = presentation.listings.find((listing) => listing.id === 'toybox')
  const componentIds = new Set(catalog.presentationGroups.find((entry) => entry.id === 'toybox').componentIds)

  assert.ok(group)
  assert.equal(catalog.packages.filter((component) => componentIds.has(component.id)).length, 8)
  assert.equal(presentation.listings.filter((listing) => componentIds.has(listing.id)).length, 0)
  assert.equal(group.presentationGroup.components.length, 8)
  assert.deepEqual(group.presentationGroup.componentCounts, { mcp: 5, skill: 3 })
  assert.equal(presentation.listings.length, catalog.packages.length - 7)
  assert.equal(catalog.stats.listings, presentation.listings.length)
})

test('presentation groups fail closed on missing or overlapping components', () => {
  const component = (id) => ({ id, repository: 'https://github.com/example/repo', ref: 'a'.repeat(40), status: 'prototype', install: {}, workshop: {} })
  assert.throws(() => buildCatalogPresentation({
    packages: [component('one'), component('two')],
    presentationGroups: [{ id: 'suite', name: 'Suite', description: 'Suite description', componentIds: ['one', 'missing'] }],
  }), /missing presentation component/)
  assert.throws(() => buildCatalogPresentation({
    packages: [component('one'), component('two'), component('three')],
    presentationGroups: [
      { id: 'suite-a', name: 'Suite A', description: 'Suite description', componentIds: ['one', 'two'] },
      { id: 'suite-b', name: 'Suite B', description: 'Suite description', componentIds: ['two', 'three'] },
    ],
  }), /more than one presentation group/)
})
