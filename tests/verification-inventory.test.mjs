import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('verification inventory covers every Catalog project and grants no false RC.6 claim', async () => {
  await exec(process.execPath, ['scripts/build-verification-inventory.mjs'], { cwd: root })
  const [inventory, catalog, admissions] = await Promise.all([
    json('verification-inventory.json'),
    json('catalog.json'),
    json('registry-admissions.json'),
  ])
  assert.equal(inventory.projects.length, catalog.packages.length)
  assert.equal(new Set(inventory.projects.map((project) => project.id)).size, catalog.packages.length)
  assert.equal(inventory.summary.verification['current-baseline-passed'] || 0, 0)
  assert.equal(inventory.summary.registry.admitted || 0, 0)
  assert.equal(inventory.summary.management.transactional, 2)
  assert.equal(inventory.summary.management.managed || 0, 0)
  assert.equal(inventory.summary.management.guided, catalog.packages.length - 2)
})

test('known blocked projects preserve their requested mode and exact blocker', async () => {
  const [inventory, admissions] = await Promise.all([
    json('verification-inventory.json'),
    json('registry-admissions.json'),
  ])
  const byId = new Map(inventory.projects.map((project) => [project.id, project]))
  for (const blocked of admissions.blocked) {
    const project = byId.get(blocked.id)
    assert.ok(project, blocked.id)
    assert.equal(project.verification.state, 'blocked')
    assert.equal(project.verification.reason, blocked.reason)
    assert.equal(project.registry.state, 'ineligible')
  }
})
