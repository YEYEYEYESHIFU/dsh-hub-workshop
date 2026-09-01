#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
  OFFICIAL_REPOSITORY_OWNERS,
} from './topic-admission-policy.mjs'
import { buildCatalogPresentation } from './catalog-presentation-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const oldCatalogPath = process.argv[2]
const topicDirectory = process.argv[3]
const auditPath = process.argv[4] || resolve(ROOT, 'topic-plugin-audit.json')

if (!oldCatalogPath || !topicDirectory) {
  throw new Error('usage: node scripts/build-topic-catalog.mjs OLD_CATALOG TOPIC_API_DIRECTORY')
}

const oldCatalog = JSON.parse(await readFile(oldCatalogPath, 'utf8'))
const existingCatalog = JSON.parse(await readFile(resolve(ROOT, 'catalog.json'), 'utf8'))
const reviewedPackages = existingCatalog.packages.filter((entry) => entry.status !== 'discovery')
const topicAudit = JSON.parse(await readFile(auditPath, 'utf8'))
const topicPages = await Promise.all([1, 2, 3].map((page) => readFile(resolve(topicDirectory, `page-${page}.json`), 'utf8').then(JSON.parse)))
const topicRepositories = topicPages.flatMap((page) => page.items)
const topicCount = topicPages[0].total_count
const auditByRepository = new Map(topicAudit.repositories.map((entry) => [`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US'), entry]))
const RETIRED_TOPIC = ['dsh', 'external'].join('-')
const publicTopics = (repository) => (repository.topics || []).filter((topic) => topic !== RETIRED_TOPIC)
const sanitizePublicText = (value = '') => String(value).replaceAll(new RegExp(RETIRED_TOPIC, 'gi'), 'retired DSH ecosystem')

if (topicRepositories.length !== topicCount) {
  throw new Error(`topic snapshot is incomplete: received ${topicRepositories.length} of ${topicCount} repositories`)
}
if (topicAudit.schema !== 'omdsh-topic-plugin-audit/v1' || topicAudit.repositories.length !== topicCount) {
  throw new Error(`plugin audit must classify all ${topicCount} Topic repositories`)
}

const safeSlug = (value) => String(value).toLocaleLowerCase('en-US').replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '')
const repositoryName = (url) => new URL(url).pathname.split('/').filter(Boolean).at(-1)
const reviewedById = new Map(reviewedPackages.map((entry) => [entry.id, entry]))
const oldEntriesByRepository = new Map()

for (const entry of oldCatalog.packages) {
  const name = repositoryName(entry.repository).toLocaleLowerCase('en-US')
  const entries = oldEntriesByRepository.get(name) || []
  entries.push(entry)
  oldEntriesByRepository.set(name, entries)
}

function inferKind(repository) {
  const text = `${repository.name} ${repository.description || ''} ${(repository.topics || []).join(' ')}`.toLocaleLowerCase('en-US')
  if (/\b(mcp|model context protocol)\b/.test(text)) return 'mcp'
  if (/\b(skill|prompt)\b/.test(text)) return 'skill'
  if (/\b(channel|telegram|feishu|wechat|wecom|qq|bot)\b/.test(text)) return 'channel'
  if (/\b(ui|web|sidebar|panel|theme|skin|renderer|terminal|desktop|notification)\b/.test(text)) return 'ui'
  if (/\b(adapter|bridge|compat)\b/.test(text)) return 'adapter'
  if (/\b(manager|registry|marketplace|installer)\b/.test(text)) return 'manager'
  if (/\b(toolkit|tools|tool)\b/.test(text)) return 'toolkit'
  return 'extension'
}

function inferCategory(repository) {
  const text = `${repository.name} ${repository.description || ''} ${(repository.topics || []).join(' ')}`.toLocaleLowerCase('en-US')
  if (/\b(memory|session|context|recall|compact)\b/.test(text)) return 'memory'
  if (/\b(channel|telegram|feishu|wechat|wecom|qq|bot)\b/.test(text)) return 'channels'
  if (/\b(security|audit|safety|guard|approval|permission)\b/.test(text)) return 'safety'
  if (/\b(ui|web|sidebar|panel|theme|skin|renderer|terminal|desktop|notification|game)\b/.test(text)) return 'interface'
  if (/\b(windows|macos|linux|adapter|bridge|compat)\b/.test(text)) return 'platform'
  if (/\b(manager|registry|runtime|infrastructure|installer)\b/.test(text)) return 'infrastructure'
  if (/\b(fun|weather|fortune|pet|chess|gomoku|dice|color)\b/.test(text)) return 'fun'
  if (/\b(workflow|issue|review|progress|artifact)\b/.test(text)) return 'workflow'
  return 'developer-tools'
}

function topicEntry(repository) {
  const id = safeSlug(`${repository.owner.login}/${repository.name}`)
  return {
    id,
    name: repository.name,
    description: sanitizePublicText(repository.description || `GitHub dsh-plugin Topic 中的公开仓库：${repository.full_name}。`),
    kind: inferKind(repository),
    category: inferCategory(repository),
    tags: [...new Set(['dsh-plugin', ...publicTopics(repository)])].slice(0, 8),
    author: {
      name: repository.owner.login,
      url: repository.owner.html_url,
    },
    repository: repository.html_url,
    repositoryPath: '',
    ref: repository.default_branch || 'main',
    updatedAt: repository.pushed_at || repository.updated_at,
    license: '见仓库',
    status: 'discovery',
    compatibility: '已发现可核验的 DSH 插件契约；尚未经过 Workshop 兼容与安装审核。',
    install: {
      type: 'manual',
      label: '查看公开来源',
      source: repository.html_url,
      command: repository.html_url,
      note: '插件契约证据只用于 Catalog 收录。请先检查源码、许可证、固定版本、权限和运行环境；该条目尚未获得 Registry 安装权限。',
    },
    featured: false,
    discovery: {
      source: 'github-topic',
      topic: 'dsh-plugin',
      stars: repository.stargazers_count,
      createdAt: repository.created_at,
      commitUpdatedAt: repository.pushed_at || repository.updated_at,
      metadataUpdatedAt: repository.updated_at,
      archived: repository.archived,
      qualification: auditByRepository.get(repository.full_name.toLocaleLowerCase('en-US'))?.reasonCode,
    },
  }
}

function migratedOldEntry(oldEntry, repository) {
  const reviewed = reviewedById.get(oldEntry.id)
  if (reviewed) {
    return {
      ...reviewed,
      updatedAt: repository.pushed_at || repository.updated_at,
      discovery: {
        ...(reviewed.discovery || {}),
        source: 'github-topic-reviewed',
        topic: 'dsh-plugin',
        stars: repository.stargazers_count,
        createdAt: repository.created_at,
        commitUpdatedAt: repository.pushed_at || repository.updated_at,
        metadataUpdatedAt: repository.updated_at,
        archived: repository.archived,
        qualification: auditByRepository.get(repository.full_name.toLocaleLowerCase('en-US'))?.reasonCode,
      },
    }
  }
  return {
    id: oldEntry.id,
    name: oldEntry.name,
    description: sanitizePublicText(oldEntry.description),
    kind: oldEntry.kind,
    category: oldEntry.category,
    tags: [...new Set(['dsh-plugin', ...(oldEntry.tags || []).filter((tag) => tag !== RETIRED_TOPIC), ...publicTopics(repository)])].slice(0, 8),
    author: {
      name: repository.owner.login,
      url: repository.owner.html_url,
    },
    repository: repository.html_url,
    repositoryPath: oldEntry.repositoryPath || '',
    ref: repository.default_branch || 'main',
    updatedAt: repository.pushed_at || repository.updated_at,
    version: oldEntry.version,
    license: oldEntry.license || '见仓库',
    status: 'discovery',
    compatibility: '从归档版 DSH Hub 恢复条目信息，并映射到当前具备插件契约证据的公开仓库；尚未重新完成兼容审核。',
    install: {
      type: 'manual',
      label: '查看公开来源',
      source: repository.html_url,
      command: repository.html_url,
      note: '旧版安装坐标和权限说明已停用。当前条目只提供已识别的插件公开来源，安装前须重新核验。',
    },
    featured: Boolean(oldEntry.featured),
    discovery: {
      source: 'archive-and-github-topic',
      topic: 'dsh-plugin',
      archivedCatalogId: oldEntry.id,
      stars: repository.stargazers_count,
      createdAt: repository.created_at,
      commitUpdatedAt: repository.pushed_at || repository.updated_at,
      metadataUpdatedAt: repository.updated_at,
      archived: repository.archived,
      qualification: auditByRepository.get(repository.full_name.toLocaleLowerCase('en-US'))?.reasonCode,
    },
  }
}

const packages = []
const representedRepositories = new Set()
const reviewedRepositories = new Set(reviewedPackages.map((entry) => entry.repository.toLocaleLowerCase('en-US')))

for (const repository of topicRepositories) {
  const audit = auditByRepository.get(repository.full_name.toLocaleLowerCase('en-US'))
  if (!audit) throw new Error(`missing plugin classification for ${repository.full_name}`)
  if (audit.decision !== 'include') continue
  if (reviewedRepositories.has(repository.html_url.toLocaleLowerCase('en-US'))) {
    representedRepositories.add(repository.full_name.toLocaleLowerCase('en-US'))
    continue
  }
  const oldEntries = oldEntriesByRepository.get(repository.name.toLocaleLowerCase('en-US')) || []
  if (oldEntries.length) {
    packages.push(...oldEntries.map((entry) => migratedOldEntry(entry, repository)))
    representedRepositories.add(repository.full_name.toLocaleLowerCase('en-US'))
    continue
  }
  packages.push(topicEntry(repository))
  representedRepositories.add(repository.full_name.toLocaleLowerCase('en-US'))
}

for (const entry of reviewedPackages) {
  if (!packages.some((candidate) => candidate.id === entry.id)) packages.push(entry)
}

const countBy = (field) => Object.fromEntries([...new Set(packages.map((entry) => entry[field]))].sort().map((value) => [value, packages.filter((entry) => entry[field] === value).length]))
const installMethods = Object.fromEntries([...new Set(packages.map((entry) => entry.install.type))].sort().map((value) => [value, packages.filter((entry) => entry.install.type === value).length]))
const presentationGroups = existingCatalog.presentationGroups || []
const presentation = buildCatalogPresentation({ packages, presentationGroups })
const catalog = {
  schema: 'dsh-hub-index/v0.4',
  hub: 'github:omdsh-dev/dsh-hub-workshop',
  updated: new Date().toISOString(),
  policy: {
    discovery: 'The dsh-plugin Topic is only a candidate source. Catalog inclusion requires file-level evidence of a DSH plugin contract or a manually verified plugin subproject.',
    creation: `Community plugin repositories must be created at or after ${COMMUNITY_PLUGIN_CREATED_AT_CUTOFF}; official owner exemptions are explicit and identity-based.`,
    exclusions: 'Core products, ecosystem infrastructure, distributions, awesome lists, documentation, templates, standalone applications, placeholders, unavailable private sources, and Topic-only repositories are excluded.',
    archive: 'Detailed legacy records are restored only when they map to a currently qualified plugin repository.',
    authority: 'Plugin qualification and archive mapping do not grant Registry installation authority.',
  },
  stats: {
    packages: packages.length,
    listings: presentation.listings.length,
    repositories: representedRepositories.size,
    observedTopicRepositories: topicCount,
    qualifiedRepositories: topicAudit.stats.decisions.include,
    pendingRepositories: topicAudit.stats.decisions.review,
    excludedRepositories: topicAudit.stats.decisions.exclude,
    reviewed: packages.filter((entry) => entry.status !== 'discovery').length,
    featured: packages.filter((entry) => entry.featured).length,
    categories: countBy('category'),
    kinds: countBy('kind'),
    installMethods,
  },
  presentationGroups,
  packages,
  plugins: [],
  distros: [],
}

const topicSnapshot = {
  schema: 'dsh-topic-discovery/v1',
  generatedAt: catalog.updated,
  topic: 'dsh-plugin',
  source: 'https://github.com/search?q=topic%3Adsh-plugin&type=repositories',
  observedRepositoryCount: topicCount,
  status: 'discovery-only',
  collection: {
    method: 'captured-github-search-pages',
    pluginCreationPolicy: {
      communityCreatedAtCutoff: COMMUNITY_PLUGIN_CREATED_AT_CUTOFF,
      officialOwnerExemptions: OFFICIAL_REPOSITORY_OWNERS,
    },
  },
  repositories: topicRepositories.map((repository) => ({
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

await Promise.all([
  writeFile(resolve(ROOT, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`),
  writeFile(resolve(ROOT, 'topic-repositories.json'), `${JSON.stringify(topicSnapshot, null, 2)}\n`),
])

console.log(JSON.stringify({
  topicRepositories: topicCount,
  catalogEntries: packages.length,
  reviewedEntries: catalog.stats.reviewed,
  qualifiedRepositories: catalog.stats.qualifiedRepositories,
  pendingRepositories: catalog.stats.pendingRepositories,
  excludedRepositories: catalog.stats.excludedRepositories,
  restoredArchiveEntries: packages.filter((entry) => entry.discovery?.source === 'archive-and-github-topic').length,
}, null, 2))
