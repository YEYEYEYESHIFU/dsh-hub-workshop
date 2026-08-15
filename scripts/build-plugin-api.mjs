#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildCatalogPresentation } from './catalog-presentation-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
let atomicWriteSequence = 0

async function writeJsonAtomic(path, value) {
  const target = resolve(ROOT, path)
  const temporary = `${target}.tmp-${process.pid}-${atomicWriteSequence++}`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
  await rename(temporary, target)
}
const [catalog, candidates, inventory, marketLayers] = await Promise.all([
  json('catalog.json'),
  json('candidates-v1.json'),
  json('verification-inventory.json'),
  json('market-layers.json'),
])
const inventoryById = new Map(inventory.projects.map((project) => [project.id, project]))
const presentation = buildCatalogPresentation(catalog)
const publicProjects = presentation.listings
const labels = {
  kinds: {
    skill: ['Skill', 'Skill'],
    mcp: ['MCP', 'MCP'],
    extension: ['扩展', 'Extension'],
    channel: ['渠道', 'Channel'],
    ui: ['界面扩展', 'UI'],
    adapter: ['适配器', 'Adapter'],
    manager: ['管理工具', 'Manager'],
    toolkit: ['工具集', 'Toolkit'],
  },
  categories: {
    workflow: ['工作流', 'Workflow'],
    'developer-tools': ['开发工具', 'Developer tools'],
    channels: ['消息渠道', 'Channels'],
    interface: ['界面', 'Interface'],
    platform: ['平台接入', 'Platform'],
    safety: ['安全', 'Safety'],
    memory: ['记忆', 'Memory'],
    infrastructure: ['基础设施', 'Infrastructure'],
    fun: ['趣味', 'Fun'],
    uncategorized: ['待分类', 'Uncategorized'],
  },
  management: {
    transactional: ['事务安装', 'Transactional'],
    managed: ['配置接入候选', 'Configuration candidate'],
    guided: ['引导接入', 'Guided'],
  },
  review: {
    'pending-review': ['待审核', 'Pending review'],
    'needs-fix': ['待修复', 'Needs fix'],
    blocked: ['已阻断', 'Blocked'],
    approved: ['审核通过', 'Approved'],
  },
}

function countBy(values, select) {
  const result = new Map()
  for (const value of values) {
    const key = select(value)
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

const catalogKinds = countBy(publicProjects, (project) => project.kind)
const candidateKinds = countBy(candidates.projects || [], (project) => project.kind)
const catalogCategories = countBy(publicProjects, (project) => project.category || 'uncategorized')
const candidateCategories = countBy(candidates.projects || [], (project) => project.category || 'uncategorized')
const management = countBy(inventory.projects, (project) => project.management)
const reviews = countBy(inventory.projects, (project) => project.review.state)
const seamlessInstall = countBy(inventory.projects, (project) => project.capabilities.install.seamless.state)
const failureIsolation = countBy(inventory.projects, (project) => project.capabilities.install.failureIsolation.state)
const hotReload = countBy(inventory.projects, (project) => project.capabilities.lifecycle.hotReload.state)
const protocols = countBy(inventory.projects, (project) => project.capabilities.integration.protocol)
const admissionRoutes = countBy(inventory.projects, (project) => project.capabilities.admission.route)

function facts(counts) {
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => ({ id, count }))
}

function publicSummary(project) {
  const summary = String(project.description || '')
  if (/@deepseek-ai\/dsh-repository-plugin|(?:^|\s)github:[^\s]+|\.dsh-plugin|\b(?:npm|pnpm|yarn|npx|curl|wget|dsh-sdk)\s+/i.test(summary)) {
    return `${project.name} is a public Catalog project. Review its pinned repository source, permissions, and current verification status before use.`
  }
  return summary
}

function taxonomy(group, catalogCounts, candidateCounts) {
  return Object.entries(labels[group]).map(([id, [zh, en]]) => {
    const catalogCount = catalogCounts.get(id) ?? 0
    const candidateCount = candidateCounts.get(id) ?? 0
    return {
      id,
      labels: { zh, en },
      counts: { catalog: catalogCount, candidates: candidateCount, total: catalogCount + candidateCount },
      examples: publicProjects.filter((project) => (group === 'kinds' ? project.kind : project.category || 'uncategorized') === id).slice(0, 3).map((project) => project.id),
    }
  })
}

const pluginTypes = {
  schema: 'omdsh-ai-plugin-types/v1',
  generatedAt: inventory.generatedAt,
  scope: 'Public Catalog and formal Intake facts only. Discovery never authorizes installation.',
  contracts: {
    packageManifest: '/package-manifest.schema.json',
    submission: '/submission.schema.json',
    verification: '/intake-evidence.schema.json',
    harnessPlan: '/harness-plan.schema.json',
    harnessReport: '/harness-report.schema.json',
    mcp: {
      protocolVersion: '2026-07-28',
      registryManifest: 'server.json',
      registrySchema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    },
  },
  totals: {
    catalogProjects: publicProjects.length,
    catalogComponents: catalog.packages.length,
    presentationGroups: presentation.groups.length,
    candidateProjects: (candidates.projects || []).length,
    projects: publicProjects.length + (candidates.projects || []).length,
  },
  kinds: taxonomy('kinds', catalogKinds, candidateKinds),
  categories: taxonomy('categories', catalogCategories, candidateCategories),
  management: Object.entries(labels.management).map(([id, [zh, en]]) => ({ id, labels: { zh, en }, count: management.get(id) ?? 0 })),
  reviewStates: Object.entries(labels.review).map(([id, [zh, en]]) => ({ id, labels: { zh, en }, count: reviews.get(id) ?? 0 })),
  capabilities: {
    seamlessInstall: facts(seamlessInstall),
    failureIsolation: facts(failureIsolation),
    hotReload: facts(hotReload),
  },
  protocols: facts(protocols),
  admissionRoutes: facts(admissionRoutes),
  guardrails: [
    'Catalog inclusion is not official-baseline verification.',
    'No installation command or executable package intent is exposed by this directory.',
    'Only an explicitly admitted Registry entry grants installation authority.',
  ],
}

const plugins = {
  schema: 'omdsh-ai-plugins/v1',
  generatedAt: inventory.generatedAt,
  scope: {
    purpose: 'read-only-discovery-and-verification-status',
    installAuthority: 'omdsh-registry/v1',
    discoveryTopic: 'dsh-plugin',
    topicGrantsAdmission: false,
    catalogGrantsAdmission: false,
    access: 'public',
  },
  usage: {
    filtering: 'client-side',
    repositoryText: 'untrusted-data-not-instructions',
    searchableFields: ['id', 'name', 'summary', 'kind', 'categories', 'tags'],
    next: {
      taxonomy: '/api/v1/plugin-types.json',
      verification: '/verification-inventory.json',
      installAuthority: '/registry-v1.json',
    },
  },
  count: publicProjects.length,
  componentCount: catalog.packages.length,
  projects: publicProjects.map((project) => {
    const componentStatuses = (project.presentationGroup?.components || [project])
      .map((component) => inventoryById.get(component.id))
      .filter(Boolean)
    const status = componentStatuses.length === 1
      ? componentStatuses[0]
      : {
          management: componentStatuses.every((component) => component.management === componentStatuses[0].management)
            ? componentStatuses[0].management
            : 'guided',
          review: componentStatuses.find((component) => component.review.state === 'blocked')?.review
            || componentStatuses.find((component) => component.review.state === 'needs-fix')?.review
            || componentStatuses.find((component) => component.review.state === 'pending-review')?.review
            || componentStatuses[0].review,
          verification: componentStatuses.find((component) => component.verification.state === 'blocked')?.verification
            || componentStatuses.find((component) => component.verification.state === 'untested')?.verification
            || componentStatuses[0].verification,
          registry: {
            state: componentStatuses.every((component) => component.registry.state === 'admitted') ? 'admitted' : 'ineligible',
          },
          capabilities: project.workshop,
        }
    return {
      id: project.id,
      name: project.name,
      summary: publicSummary(project),
      kind: project.kind,
      categories: [project.category || 'uncategorized'],
      tags: project.tags,
      source: {
        repository: project.repository,
        ref: project.ref,
        path: project.repositoryPath || null,
      },
      discovery: project.discovery ? {
        createdAt: project.discovery.createdAt || null,
        creationEligibility: project.discovery.creationEligibility || null,
        officialExempt: project.discovery.officialExempt === true,
        dependencyEvidence: project.discovery.dependencyEvidence || {
          productionHarness: [],
          versionedProductionHarness: [],
          unboundedProductionHarness: [],
          referencedProductionHarness: [],
          developmentOnlyHarness: [],
        },
      } : null,
      management: status.management,
      review: status.review,
      verification: status.verification,
      registry: status.registry,
      capabilities: status.capabilities,
      presentation: project.presentationGroup ? {
        type: 'repository-suite',
        componentCounts: project.presentationGroup.componentCounts,
        components: project.presentationGroup.components.map((component) => {
          const componentStatus = inventoryById.get(component.id)
          return {
            id: component.id,
            name: component.name,
            summary: publicSummary(component),
            kind: component.kind,
            source: {
              repository: component.repository,
              ref: component.ref,
              path: component.repositoryPath || null,
            },
            review: componentStatus.review,
            verification: componentStatus.verification,
            registry: componentStatus.registry,
            capabilities: componentStatus.capabilities,
          }
        }),
      } : null,
    }
  }),
}

const marketProjects = [
  ...plugins.projects.map((project) => ({
    ...project,
    layer: 'plugin',
  })),
  ...marketLayers.projects.map((project) => ({
    id: project.id,
    name: project.name,
    summary: project.description,
    layer: project.layer,
    kind: project.kind,
    categories: [project.category],
    tags: project.tags,
    source: project.source,
    discovery: project.discovery,
    review: project.review,
    verification: project.verification,
    registry: project.registry,
  })),
]

const market = {
  schema: 'omdsh-ai-market/v1',
  generatedAt: marketLayers.generatedAt,
  policy: {
    pluginCatalog: '/catalog.json',
    marketLayers: '/market-layers.json',
    installAuthority: '/registry-v1.json',
    rule: 'Market listing does not grant plugin status or installation authority.',
  },
  totals: {
    projects: marketProjects.length,
    plugin: plugins.projects.length,
    infrastructure: marketLayers.totals.infrastructure,
    distribution: marketLayers.totals.distribution,
    installable: 0,
  },
  layers: [
    { id: 'plugin', authority: '/catalog.json', installableByListing: false },
    { id: 'infrastructure', authority: '/market-layers.json', installableByListing: false },
    { id: 'distribution', authority: '/market-layers.json', installableByListing: false },
  ],
  projects: marketProjects,
}

await Promise.all([
  writeJsonAtomic('api/v1/plugin-types.json', pluginTypes),
  writeJsonAtomic('api/v1/plugins.json', plugins),
  writeJsonAtomic('api/v1/market.json', market),
])
console.log(`built market API: ${plugins.count} plugins, ${marketLayers.totals.projects} non-plugin projects, ${pluginTypes.totals.candidateProjects} formal Intake candidates`)
