import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { inspectRealProject, parseLegacySource, validateRealProjectReview } from '../scripts/real-project-review-lib.mjs'

test('legacy public project stops before adapter and grants no RC.6 claim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'real-project-review-test-'))
  try {
    await mkdir(join(root, 'plugins/demo/.dsh-plugin'), { recursive: true })
    await writeFile(join(root, 'LICENSE'), 'MIT\n')
    await writeFile(join(root, 'plugins/demo/.dsh-plugin/SKILL.md'), '# Demo\n')
    await writeFile(join(root, 'plugins/demo/.dsh-plugin/package.json'), JSON.stringify({
      name: 'demo',
      version: '0.1.0-rc.1',
      private: true,
      license: 'MIT',
      scripts: { prepare: 'node prepare.js' },
      dsh: { skills: ['SKILL.md'] },
    }))
    await writeFile(join(root, 'plugins/demo/.dsh-plugin/prepare.js'), 'console.log("not executed")\n')
    const review = await inspectRealProject({
      candidate: {
        id: 'demo',
        source: `github:example/demo#${'a'.repeat(40)}&path:/plugins/demo/.dsh-plugin`,
        mode: 'repository-plugin',
        version: '0.1.0',
        license: 'MIT',
        kind: 'skill',
      },
      checkoutRoot: root,
      observedDefaultHead: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      reviewedAt: '2026-08-14T00:00:00.000Z',
    })
    assert.equal(review.source.publiclyReachable, true)
    assert.equal(review.package.workshopManifest, 'absent')
    assert.equal(review.typePlan.state, 'blocked')
    assert.equal(review.adapter.state, 'blocked')
    assert.equal(review.trustReview.sourceExecutionAuthorized, false)
    assert.equal(review.humanReview.state, 'pending')
    assert.equal(review.admission.state, 'not-created')
    assert.equal(review.claims.rc6Verified, false)
    assert.deepEqual(validateRealProjectReview(review), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fixed legacy GitHub source parser preserves repository, commit, and leaf path', () => {
  const ref = 'c'.repeat(40)
  assert.deepEqual(parseLegacySource(`github:owner/repo#${ref}&path:/plugins/leaf/.dsh-plugin`), {
    repository: 'https://github.com/owner/repo',
    ref,
    path: '/plugins/leaf/.dsh-plugin',
  })
})

test('generated review cannot self-approve RC.6 or admission', () => {
  const review = {
    schema: 'omdsh-workshop-real-project-review/v1',
    id: 'demo',
    source: { ref: 'd'.repeat(40), publiclyReachable: true },
    sequence: ['fixed-source', 'type-plan', 'trust-review', 'adapter', 'evidence', 'human-review', 'admission'].map((stage) => ({ stage })),
    typePlan: { state: 'ready' },
    trustReview: { sourceExecutionAuthorized: false },
    adapter: { state: 'passed' },
    humanReview: { state: 'approved' },
    admission: { state: 'admitted' },
    claims: { rc6Verified: true },
  }
  const errors = validateRealProjectReview(review)
  assert.ok(errors.some((error) => error.includes('RC.6')))
  assert.ok(errors.some((error) => error.includes('human review')))
  assert.ok(errors.some((error) => error.includes('admit')))
})
