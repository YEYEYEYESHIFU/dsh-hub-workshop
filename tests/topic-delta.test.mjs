import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTopicDelta, repositoryFingerprint } from '../scripts/topic-delta-lib.mjs'

const repository = (name, changes = {}) => ({
  repositoryId: [...name].reduce((total, character) => total + character.codePointAt(0), 1000),
  owner: 'example',
  name,
  url: `https://github.com/example/${name}`,
  description: 'DSH plugin',
  language: 'JavaScript',
  topics: ['dsh-plugin'],
  archived: false,
  defaultBranch: 'main',
  createdAt: '2026-08-01T00:00:00Z',
  commitUpdatedAt: '2026-08-14T00:00:00Z',
  metadataUpdatedAt: '2026-08-14T00:00:00Z',
  ...changes
})
const snapshot = (repositories, generatedAt) => ({
  schema: 'dsh-topic-discovery/v1',
  topic: 'dsh-plugin',
  generatedAt,
  repositories
})

test('Topic delta is content-addressed and separates add, update, remove, and unchanged', () => {
  const previous = snapshot([repository('same'), repository('changed'), repository('removed')], '2026-08-14T00:00:00Z')
  const current = snapshot([
    repository('same'),
    repository('changed', { commitUpdatedAt: '2026-08-15T00:00:00Z' }),
    repository('added')
  ], '2026-08-15T00:00:00Z')
  const delta = buildTopicDelta(previous, current)
  assert.deepEqual(delta.counts, { previous: 3, current: 3, added: 1, updated: 1, removed: 1, unchanged: 1 })
  assert.deepEqual(delta.changes.map((item) => item.change).sort(), ['added', 'removed', 'updated'])
  assert.equal(repositoryFingerprint(previous.repositories[0]), repositoryFingerprint(current.repositories[0]))
})

test('Topic delta rejects unrelated snapshot contracts', () => {
  assert.throws(() => buildTopicDelta({ schema: 'wrong' }, snapshot([], '2026-08-15T00:00:00Z')), /requires two/)
})

test('Topic identity survives a rename when the GitHub numeric repository ID is stable', () => {
  const before = repository('before', { repositoryId: 4242 })
  const after = repository('after', { repositoryId: 4242, commitUpdatedAt: before.commitUpdatedAt })
  const delta = buildTopicDelta(snapshot([before], '2026-08-14T00:00:00Z'), snapshot([after], '2026-08-15T00:00:00Z'))
  assert.equal(delta.counts.added, 0)
  assert.equal(delta.counts.removed, 0)
  assert.equal(delta.counts.updated, 1)
  assert.equal(delta.changes[0].repository, 'github:4242')
})
