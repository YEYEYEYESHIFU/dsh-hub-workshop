import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = new URL('../', import.meta.url)
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'))

test('verification inventory covers every Catalog project and reflects typed Harness evidence without granting admission', async () => {
  await exec(process.execPath, ['scripts/build-verification-inventory.mjs'], { cwd: root })
  const [inventory, catalog, admissions] = await Promise.all([
    json('verification-inventory.json'),
    json('catalog.json'),
    json('registry-admissions.json'),
  ])
  assert.equal(inventory.projects.length, catalog.packages.length)
  assert.equal(new Set(inventory.projects.map((project) => project.id)).size, catalog.packages.length)
  assert.equal(inventory.summary.verification['current-baseline-passed'] || 0, 1)
  assert.equal(inventory.summary.verification['source-evidence-passed'] || 0, 9)
  assert.equal(inventory.summary.verification.blocked || 0, 1)
  assert.equal(inventory.summary.registry.admitted || 0, 0)
  assert.equal(inventory.summary.management.transactional, 2)
  assert.equal(inventory.summary.management.managed || 0, 0)
  assert.equal(inventory.summary.management.guided, catalog.packages.length - 2)
})

test('excluded projects preserve the exact Intake verification state', async () => {
  const [inventory, admissions, queue] = await Promise.all([
    json('verification-inventory.json'),
    json('registry-admissions.json'),
    json('intake-queue.json'),
  ])
  const byId = new Map(inventory.projects.map((project) => [project.id, project]))
  const queueById = new Map(queue.records.map((record) => [record.submission.manifest.project.id, record]))
  for (const blocked of admissions.blocked) {
    const project = byId.get(blocked.id)
    const record = queueById.get(blocked.id)
    assert.ok(project, blocked.id)
    assert.equal(project.verification.state, record.verification.state)
    assert.equal(project.verification.reason, record.verification.evidence)
    assert.equal(project.registry.state, 'ineligible')
  }
})
