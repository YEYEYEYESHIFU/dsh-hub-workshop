#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  OFFICIAL_REPOSITORY_OWNERS,
  isRetiredRepositoryOwner,
} from './topic-admission-policy.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TOPIC = 'dsh-plugin'
const USER_AGENT = 'omdsh-workshop-topic-refresh/2.0'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() || ''
const REQUEST_INTERVAL_MS = GITHUB_TOKEN ? 2_200 : 6_500
const decoder = new TextDecoder()
let lastRequestAt = 0

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))

async function search(query, page) {
  const elapsed = Date.now() - lastRequestAt
  if (elapsed < REQUEST_INTERVAL_MS) await wait(REQUEST_INTERVAL_MS - elapsed)
  const url = new URL('https://api.github.com/search/repositories')
  url.searchParams.set('q', query)
  url.searchParams.set('per_page', '100')
  url.searchParams.set('page', String(page))
  url.searchParams.set('sort', 'updated')
  url.searchParams.set('order', 'desc')
  lastRequestAt = Date.now()
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  })
  if (!response.ok) {
    const body = decoder.decode((await response.arrayBuffer()).slice(0, 800))
    throw new Error(`GitHub Search HTTP ${response.status}: ${body}`)
  }
  const value = await response.json()
  if (value.incomplete_results) throw new Error(`GitHub Search returned incomplete results for ${query}`)
  return value
}

function utcDate(offsetDays = 0) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

const yesterday = utcDate(-1)
const today = utcDate(0)
const partitions = [
  `topic:${TOPIC} created:<${yesterday}`,
  `topic:${TOPIC} created:${yesterday}`,
  `topic:${TOPIC} created:${today}T00:00:00Z..${today}T05:59:59Z`,
  `topic:${TOPIC} created:${today}T06:00:00Z..${today}T11:59:59Z`,
  `topic:${TOPIC} created:${today}T12:00:00Z..${today}T17:59:59Z`,
  `topic:${TOPIC} created:>=${today}T18:00:00Z`,
]
const repositoriesByName = new Map()
let observed = 0
let observedPages = 0
for (const query of partitions) {
  const first = await search(query, 1)
  if (first.total_count > 1_000) throw new Error(`partition exceeds the GitHub Search 1,000-result cap: ${query} (${first.total_count})`)
  observed += first.total_count
  const pages = Math.ceil(first.total_count / 100)
  observedPages += pages
  for (let page = 1; page <= pages; page += 1) {
    const value = page === 1 ? first : await search(query, page)
    for (const repository of value.items) {
      const key = repository.full_name.toLocaleLowerCase('en-US')
      const previous = repositoriesByName.get(key)
      if (!previous || String(repository.updated_at) > String(previous.updated_at)) repositoriesByName.set(key, repository)
    }
    process.stderr.write(`captured ${query} page ${page}/${pages}\n`)
  }
}
if (repositoriesByName.size !== observed) {
  throw new Error(`partitioned Topic snapshot mismatch: received ${repositoriesByName.size} unique repositories, expected ${observed}`)
}

const RETIRED_TOPIC = ['dsh', 'external'].join('-')
const publicTopics = (repository) => (repository.topics || []).filter((topic) => topic !== RETIRED_TOPIC)
const sanitizePublicText = (value = '') => String(value)
  .replaceAll(new RegExp(RETIRED_TOPIC, 'gi'), 'retired DSH ecosystem')
  .replaceAll(/\bNDA\b/gi, 'previous restricted program')
  .replaceAll('内测', '社区阶段')
const generatedAt = new Date().toISOString()
const discoveredRepositories = [...repositoriesByName.values()]
  .sort((left, right) => String(right.pushed_at || right.updated_at).localeCompare(String(left.pushed_at || left.updated_at)))
const repositories = discoveredRepositories.filter((repository) => !isRetiredRepositoryOwner(repository))
const snapshot = {
  schema: 'dsh-topic-discovery/v1',
  generatedAt,
  topic: TOPIC,
  source: 'https://github.com/search?q=topic%3Adsh-plugin&type=repositories',
  observedRepositoryCount: repositories.length,
  status: 'discovery-only',
  collection: {
    method: `${GITHUB_TOKEN ? 'authenticated' : 'anonymous'}-partitioned-github-search`,
    partitions,
    searchCapHandled: true,
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
discovery.topic.observedPages = observedPages
discovery.topic.observedRepositoryCount = repositories.length
discovery.topic.collection = snapshot.collection

await Promise.all([
  writeFile(resolve(ROOT, 'topic-repositories.json'), `${JSON.stringify(snapshot, null, 2)}\n`),
  writeFile(discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`),
])
console.log(`refreshed public Topic snapshot: ${repositories.length} repositories across ${partitions.length} non-overlapping partitions (${discoveredRepositories.length - repositories.length} retired-owner sources excluded)`)
