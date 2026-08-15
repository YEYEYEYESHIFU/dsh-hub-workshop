#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  OFFICIAL_REPOSITORY_OWNERS,
  isRetiredRepositoryOwner,
} from './topic-admission-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const inputDirectory = process.argv[2]
if (!inputDirectory) throw new Error('usage: node scripts/refresh-topic-snapshot.mjs TOPIC_API_DIRECTORY')

const files = (await readdir(resolve(inputDirectory)))
  .filter((name) => name.endsWith('.json'))
  .sort()
const pages = []
for (const name of files) {
  const value = JSON.parse(await readFile(resolve(inputDirectory, name), 'utf8'))
  if (Array.isArray(value?.items)) pages.push(value)
}
if (!pages.length) throw new Error('no GitHub repository search pages found')

const expected = Math.max(...pages.map((page) => Number(page.total_count) || 0))
const repositoriesByName = new Map()
for (const repository of pages.flatMap((page) => page.items)) {
  const existing = repositoriesByName.get(repository.full_name.toLocaleLowerCase('en-US'))
  if (!existing || String(repository.updated_at) > String(existing.updated_at)) {
    repositoriesByName.set(repository.full_name.toLocaleLowerCase('en-US'), repository)
  }
}
const discoveredRepositories = [...repositoriesByName.values()]
  .sort((left, right) => String(right.pushed_at || right.updated_at).localeCompare(String(left.pushed_at || left.updated_at)))
if (discoveredRepositories.length !== expected) {
  throw new Error(`Topic snapshot is incomplete: received ${discoveredRepositories.length} unique repositories, expected ${expected}`)
}
const repositories = discoveredRepositories.filter((repository) => !isRetiredRepositoryOwner(repository))

const RETIRED_TOPIC = ['dsh', 'external'].join('-')
const publicTopics = (repository) => (repository.topics || []).filter((topic) => topic !== RETIRED_TOPIC)
const sanitizePublicText = (value = '') => String(value)
  .replaceAll(new RegExp(RETIRED_TOPIC, 'gi'), 'retired DSH ecosystem')
  .replaceAll(/\bNDA\b/gi, 'previous restricted program')
  .replaceAll('内测', '社区阶段')
const generatedAt = new Date().toISOString()
const snapshot = {
  schema: 'dsh-topic-discovery/v1',
  generatedAt,
  topic: 'dsh-plugin',
  source: 'https://github.com/search?q=topic%3Adsh-plugin&type=repositories',
  observedRepositoryCount: repositories.length,
  status: 'discovery-only',
  collection: {
    method: 'captured-github-search-pages',
    pluginCreationPolicy: {
      communityCreatedAtCutoff: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
      officialOwnerExemptions: OFFICIAL_REPOSITORY_OWNERS,
    },
    retiredOwnerExclusionsApplied: true,
    excludedRepositoryCount: discoveredRepositories.length - repositories.length,
  },
  repositories: repositories.map((repository) => ({
    owner: repository.owner.login,
    name: repository.name,
    url: repository.html_url,
    description: sanitizePublicText(repository.description || ''),
    language: repository.language,
    topics: publicTopics(repository),
    createdAt: repository.created_at,
    commitUpdatedAt: repository.pushed_at || repository.updated_at,
    metadataUpdatedAt: repository.updated_at,
    stars: repository.stargazers_count,
    archived: repository.archived,
    defaultBranch: repository.default_branch || 'main',
  })),
}

const discoveryPath = resolve(ROOT, 'public-discovery.json')
const discovery = JSON.parse(await readFile(discoveryPath, 'utf8'))
discovery.generatedAt = generatedAt
discovery.topic.observedPages = Math.ceil(repositories.length / 100)
discovery.topic.observedRepositoryCount = repositories.length

await Promise.all([
  writeFile(resolve(ROOT, 'topic-repositories.json'), `${JSON.stringify(snapshot, null, 2)}\n`),
  writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`),
])

console.log(`refreshed public Topic snapshot: ${repositories.length} repositories across ${pages.length} captured page(s) (${discoveredRepositories.length - repositories.length} retired-owner sources excluded)`)
