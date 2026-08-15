#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { capabilityProfile } from './workshop-manifest-lib.mjs'
import { buildCatalogPresentation } from './catalog-presentation-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = (path) => readFile(resolve(ROOT, path), 'utf8').then(JSON.parse)
const [catalog, audit, topic, marketLayers, admissions] = await Promise.all([
  json('catalog.json'), json('topic-plugin-audit.json'), json('topic-repositories.json'), json('market-layers.json'), json('registry-admissions.json'),
])
if (!['dsh-hub-index/v0.3', 'dsh-hub-index/v0.4'].includes(catalog.schema)) throw new Error('unsupported Catalog schema')
if (audit.schema !== 'omdsh-topic-plugin-audit/v3') throw new Error('unsupported Topic audit schema')

const repositoryKey = (url) => new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLocaleLowerCase('en-US')
const safeSlug = (value) => String(value).toLocaleLowerCase('en-US').replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '')
const topicByRepository = new Map(topic.repositories.map((entry) => [`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US'), entry]))
const auditByRepository = new Map(audit.repositories.map((entry) => [`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US'), entry]))
const blockedById = new Map(admissions.blocked.map((entry) => [entry.id, entry]))

function entryText(entry) {
  const snapshot = topicByRepository.get(`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US'))
  return `${entry.name} ${snapshot?.description || ''}`.toLocaleLowerCase('en-US')
}

function inferKind(entry) {
  const text = entryText(entry)
  if (/\bmcp\b/.test(text)) return 'mcp'
  if (/\b(skill|prompt)\b/.test(text)) return 'skill'
  if (/\b(channel|telegram|feishu|lark|wechat|wecom|qq|bot)\b/.test(text)) return 'channel'
  if (/\b(ui|web|sidebar|panel|theme|skin|renderer|terminal|notification)\b/.test(text)) return 'ui'
  if (/\b(adapter|bridge|compat)\b/.test(text)) return 'adapter'
  if (/\b(toolkit|tools|tool)\b/.test(text)) return 'toolkit'
  return 'extension'
}

function inferCategory(entry) {
  const text = entryText(entry)
  if (/\b(memory|session|context|recall|compact)\b/.test(text)) return 'memory'
  if (/\b(channel|telegram|feishu|lark|wechat|wecom|qq|bot)\b/.test(text)) return 'channels'
  if (/\b(security|audit|safety|guard|approval|permission)\b/.test(text)) return 'safety'
  if (/\b(ui|web|sidebar|panel|theme|skin|terminal|desktop|notification|tui)\b/.test(text)) return 'interface'
  return 'developer-tools'
}

function discoveryFacts(snapshot, classification) {
  const creation = classification?.evidence?.creation || {}
  const dependencies = classification?.evidence?.dependencyCheck || {}
  return {
    source: 'github-topic', topic: 'dsh-plugin',
    stars: snapshot?.stars || 0,
    createdAt: creation.createdAt || snapshot?.createdAt || null,
    commitUpdatedAt: snapshot?.commitUpdatedAt || audit.sourceSnapshotGeneratedAt,
    metadataUpdatedAt: snapshot?.metadataUpdatedAt || audit.sourceSnapshotGeneratedAt,
    archived: snapshot?.archived || false,
    qualification: classification?.reasonCode,
    creationEligibility: creation.reason || 'repository-created-at-unavailable',
    officialExempt: creation.officialExempt === true,
    dependencyEvidence: {
      productionHarness: Object.keys(dependencies.production || {}),
      versionedProductionHarness: Object.keys(dependencies.versionedProduction || {}),
      unboundedProductionHarness: Object.keys(dependencies.unboundedProduction || {}),
      referencedProductionHarness: dependencies.referencedProduction || [],
      developmentOnlyHarness: Object.keys(dependencies.developmentOnly || {}),
    },
  }
}

function legacyProtocol(classification) {
  const signals = `${classification?.reasonCode || ''} ${(classification?.evidence?.strongSignals || []).join(' ')}`
  if (/repository|\.dsh-plugin/i.test(signals)) return 'harness-repository'
  if (/bundle patch|profile/i.test(signals)) return 'harness-profile'
  if (/\bmcp\b/i.test(signals)) return 'mcp'
  if (/skill/i.test(signals)) return 'skill'
  if (/cordis|harness integration/i.test(signals)) return 'harness-cordis'
  return 'third-party'
}

function workshopFacts(classification, project = null) {
  const manifestProfile = classification?.evidence?.packageManifest?.profile
  if (classification?.evidence?.packageManifest?.status === 'valid' && manifestProfile) return structuredClone(manifestProfile)
  const source = classification?.evidence?.strongSignals?.[0] || 'curated-fixed-source'
  const profile = capabilityProfile({ manifestSource: source, integrationProtocol: legacyProtocol(classification) })
  const blockedMode = blockedById.get(project?.id)?.mode
  if (blockedMode === 'profile-bundle') profile.install.mode = 'transactional-candidate'
  if (blockedMode === 'repository-plugin') profile.install.mode = 'configuration-candidate'
  return profile
}

const reviewedEntries = catalog.packages.filter((entry) => {
  if (entry.status === 'discovery' || entry.id === 'dsh-tool-browser') return false
  const classification = auditByRepository.get(repositoryKey(entry.repository))
  return classification?.decision === 'include'
    && classification.qualification === 'verified'
    && classification.evidence?.creation?.eligible === true
})
  .map((entry) => {
    const key = repositoryKey(entry.repository)
    const classification = auditByRepository.get(key)
    const snapshot = topicByRepository.get(key)
    return {
      ...entry,
      discovery: { ...(entry.discovery || {}), ...discoveryFacts(snapshot, classification) },
      workshop: workshopFacts(classification, entry),
    }
  })
const retainedDiscoveryEntries = catalog.packages.filter((entry) => {
  if (entry.status !== 'discovery') return false
  const classification = auditByRepository.get(repositoryKey(entry.repository))
  return classification?.decision === 'include'
    && classification.qualification === 'verified'
    && (classification.evidence?.strongSignals || []).length > 0
})
  .map((entry) => {
    const key = repositoryKey(entry.repository)
    const classification = auditByRepository.get(key)
    const snapshot = topicByRepository.get(key)
    return {
      ...entry,
      description: snapshot?.description || entry.description,
      ref: classification.defaultBranch,
      updatedAt: snapshot?.commitUpdatedAt || entry.updatedAt,
      compatibility: '已识别文件级 DSH 插件制品证据；尚未经过当前官方基线安装验证。',
      install: {
        type: 'manual', label: '查看公开来源', source: entry.repository, command: entry.repository,
        note: '展示与待审核状态不授予安装权限。请先核验固定版本、许可、权限、供应链与当前官方基线。',
      },
      discovery: discoveryFacts(snapshot, classification),
      workshop: workshopFacts(classification, entry),
    }
  })

const representedRepositories = new Set([...retainedDiscoveryEntries, ...reviewedEntries].map((entry) => repositoryKey(entry.repository)))
const generatedEntries = audit.repositories
  .filter((entry) => entry.decision === 'include'
    && entry.qualification === 'verified'
    && (entry.evidence?.strongSignals || []).length > 0
    && !representedRepositories.has(`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US')))
  .map((entry) => {
    const key = `${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US')
    const snapshot = topicByRepository.get(key)
    return {
      id: safeSlug(`${entry.owner}/${entry.name}`),
      name: entry.name,
      description: snapshot?.description || `${entry.owner}/${entry.name} 声明为 DeepSeek Harness 生态插件。`,
      kind: inferKind(entry),
      category: inferCategory(entry),
      tags: ['dsh-plugin'],
      author: { name: entry.owner, url: `https://github.com/${entry.owner}` },
      repository: entry.url,
      repositoryPath: '',
      ref: entry.defaultBranch,
      updatedAt: snapshot?.commitUpdatedAt || audit.sourceSnapshotGeneratedAt,
      license: '未声明',
      status: 'discovery',
      compatibility: '已识别文件级 DSH 插件制品证据；尚未经过当前官方基线安装验证。',
      install: {
        type: 'manual', label: '查看公开来源', source: entry.url, command: entry.url,
        note: '展示与待审核状态不授予安装权限。请先核验固定版本、许可、权限、供应链与当前官方基线。',
      },
      featured: false,
      discovery: discoveryFacts(snapshot, entry),
      workshop: workshopFacts(entry),
    }
  })

const packages = [...retainedDiscoveryEntries, ...generatedEntries, ...reviewedEntries]
  .sort((left, right) => Number(right.status !== 'discovery') - Number(left.status !== 'discovery')
    || Number(right.discovery?.stars || 0) - Number(left.discovery?.stars || 0)
    || left.id.localeCompare(right.id))
const presentationGroups = catalog.presentationGroups || []
const presentation = buildCatalogPresentation({ packages, presentationGroups })
const catalogRepositories = new Set(packages.map((entry) => repositoryKey(entry.repository)))
const countBy = (field) => Object.fromEntries([...new Set(packages.map((entry) => entry[field]))]
  .sort().map((value) => [value, packages.filter((entry) => entry[field] === value).length]))
const installMethods = Object.fromEntries([...new Set(packages.map((entry) => entry.install.type))]
  .sort().map((value) => [value, packages.filter((entry) => entry.install.type === value).length]))

const catalogOutput = {
  ...catalog,
  schema: 'dsh-hub-index/v0.4',
  updated: audit.sourceSnapshotGeneratedAt,
  policy: {
    discovery: 'Topic is discovery-only. Plugin Catalog entries require a valid package.json#dshWorkshop manifest or preserved legacy file-level artifacts. Legacy entries are compatibility-mapped and still need the manifest plus current-baseline tests.',
    creation: audit.policy.creation,
    dependencies: audit.policy.dependencies,
    exclusions: 'Name, description, README claims, unavailable scans, unexpanded collections, Topic-only traffic, core products, Awesome/documentation, and templates remain outside the plugin Catalog. Genuine ecosystem infrastructure and distributions are displayed separately.',
    archive: 'Archived genuine works remain visible with their archived source fact.',
    authority: 'Catalog visibility and review state never grant Registry installation authority.',
  },
  stats: {
    packages: packages.length,
    listings: presentation.listings.length,
    repositories: catalogRepositories.size,
    observedTopicRepositories: audit.stats.repositories,
    qualifiedRepositories: audit.stats.decisions.include || 0,
    pendingRepositories: audit.stats.decisions.review || 0,
    marketRepositories: audit.stats.decisions.market || 0,
    excludedRepositories: audit.stats.decisions.exclude || 0,
    reviewed: reviewedEntries.length,
    featured: packages.filter((entry) => entry.featured).length,
    categories: countBy('category'),
    kinds: countBy('kind'),
    installMethods,
  },
  presentationGroups,
  packages,
}

const curatedMarket = marketLayers.projects.filter((project) => project.review.state === 'curated')
const curatedIds = new Set(curatedMarket.map((project) => project.id))
const discoveredMarket = audit.repositories
  .filter((entry) => entry.decision === 'market' && !curatedIds.has(`${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US')))
  .map((entry) => {
    const key = `${entry.owner}/${entry.name}`.toLocaleLowerCase('en-US')
    const snapshot = topicByRepository.get(key)
    const text = entryText(entry)
    const kind = entry.marketLayer === 'distribution'
      ? 'collection'
      : /desktop|launcher|client|terminal|tui|vscode|app|桌面|终端/i.test(text)
        ? 'application'
        : /adapter|bridge|integration|接入|桥接/i.test(text)
          ? 'integration'
          : /tool|dev|doctor|publisher|工具|诊断/i.test(text)
            ? 'toolkit'
            : 'manager'
    return {
      id: key,
      layer: entry.marketLayer,
      name: entry.name,
      description: snapshot?.description || `${entry.owner}/${entry.name} 是一个 DSH 生态项目。`,
      kind,
      category: entry.marketLayer === 'distribution' ? 'platform' : 'infrastructure',
      tags: ['dsh', entry.marketLayer === 'distribution' ? 'community-distribution' : 'ecosystem-infrastructure'],
      author: { name: entry.owner, url: `https://github.com/${entry.owner}` },
      source: { repository: entry.url, ref: entry.defaultBranch, path: null },
      updatedAt: snapshot?.commitUpdatedAt || audit.sourceSnapshotGeneratedAt,
      version: null,
      license: '未声明',
      featured: false,
      discovery: {
        stars: snapshot?.stars || 0,
        createdAt: snapshot?.createdAt || null,
        commitUpdatedAt: snapshot?.commitUpdatedAt || audit.sourceSnapshotGeneratedAt,
        metadataUpdatedAt: snapshot?.metadataUpdatedAt || audit.sourceSnapshotGeneratedAt,
        archived: snapshot?.archived || false,
      },
      review: { state: 'pending-review', reason: entry.reasonCode },
      verification: { state: 'unverified', evidence: 'GitHub Topic metadata and explicit DSH project claim; source review pending' },
      registry: { state: 'ineligible', reason: 'market-layer-not-plugin-install' },
    }
  })
const marketProjects = [...curatedMarket, ...discoveredMarket]
  .sort((left, right) => Number(right.review.state === 'curated') - Number(left.review.state === 'curated')
    || Number(right.discovery?.stars || 0) - Number(left.discovery?.stars || 0)
    || left.id.localeCompare(right.id))
const marketOutput = {
  ...marketLayers,
  schema: 'omdsh-market-layers/v2',
  generatedAt: audit.sourceSnapshotGeneratedAt,
  policy: {
    ...marketLayers.policy,
    infrastructure: 'Genuine DSH clients, managers, marketplaces, integrations, and developer tools are displayed separately from leaf plugins.',
    distribution: 'Genuine plugin collections and community distributions are displayed without inheriting installation authority from components.',
    excluded: 'Awesome/documentation, templates/placeholders, and Topic-only traffic matches without a DSH work claim remain outside the market.',
  },
  totals: {
    projects: marketProjects.length,
    infrastructure: marketProjects.filter((project) => project.layer === 'infrastructure').length,
    distribution: marketProjects.filter((project) => project.layer === 'distribution').length,
  },
  projects: marketProjects,
}

await Promise.all([
  writeFile(resolve(ROOT, 'catalog.json'), `${JSON.stringify(catalogOutput, null, 2)}\n`),
  writeFile(resolve(ROOT, 'market-layers.json'), `${JSON.stringify(marketOutput, null, 2)}\n`),
])
console.log(JSON.stringify({ catalog: catalogOutput.stats, market: marketOutput.totals }, null, 2))
