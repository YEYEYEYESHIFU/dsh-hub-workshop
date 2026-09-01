const statusRank = new Map([
  ['prototype', 0],
  ['beta', 1],
  ['verified', 2],
])

function weakestStatus(components) {
  return [...components]
    .sort((left, right) => (statusRank.get(left.status) ?? -1) - (statusRank.get(right.status) ?? -1))[0]?.status || 'prototype'
}

function commonValue(components, select, fallback) {
  const values = [...new Set(components.map(select).filter((value) => value !== undefined && value !== null))]
  return values.length === 1 ? values[0] : fallback
}

function groupedWorkshop(group, components) {
  const manifestsValid = components.every((component) => component.workshop?.manifest?.status === 'valid')
  const admissionReady = components.every((component) => component.workshop?.admission?.state === 'manifest-ready-for-tests')
  return {
    manifest: {
      status: manifestsValid ? 'valid' : 'legacy-evidence',
      source: `${components.length} component manifests`,
      schema: manifestsValid ? 'omdsh-workshop-package/v1' : null,
    },
    install: {
      mode: 'guided',
      adapter: 'third-party',
      seamless: { state: 'unsupported', reason: 'presentation-group-is-not-an-install-unit' },
      failureIsolation: { state: 'unknown', policy: 'manual', reason: 'verified-per-component' },
    },
    lifecycle: {
      hotReload: { state: 'unknown', activation: 'unknown', reason: 'verified-per-component' },
    },
    integration: {
      protocol: 'third-party',
      artifact: `${components.length} independently reviewed components`,
      mcp: null,
    },
    admission: {
      route: 'package-json-manifest',
      state: admissionReady ? 'manifest-ready-for-tests' : 'needs-package-manifest',
    },
  }
}

function groupedPackage(group, components) {
  const base = components[0]
  const kinds = Object.fromEntries([...new Set(components.map((component) => component.kind))]
    .sort()
    .map((kind) => [kind, components.filter((component) => component.kind === kind).length]))
  return {
    ...base,
    id: group.id,
    name: group.name,
    description: group.description,
    kind: group.kind || 'toolkit',
    category: group.category || commonValue(components, (component) => component.category, 'developer-tools'),
    tags: group.tags || [...new Set(components.flatMap((component) => component.tags || []))].slice(0, 8),
    repositoryPath: group.repositoryPath ?? '',
    version: group.version || commonValue(components, (component) => component.version, undefined),
    license: group.license || commonValue(components, (component) => component.license, '见组件'),
    status: group.status || weakestStatus(components),
    featured: group.featured ?? components.some((component) => component.featured),
    compatibility: group.compatibility || '套件只合并公开展示；兼容验证、审核结论与 Registry 准入仍按组件独立记录。',
    install: {
      ...base.install,
      label: group.installLabel || '查看公开来源',
      source: base.repository,
      command: base.repository,
      note: group.installNote || '这是公开目录分组，不是可安装单元。请在详情中逐项核验组件状态。',
    },
    workshop: groupedWorkshop(group, components),
    presentationGroup: {
      id: group.id,
      componentIds: components.map((component) => component.id),
      componentCounts: kinds,
      components,
    },
  }
}

export function buildCatalogPresentation(catalog) {
  const components = catalog.packages || []
  const groups = catalog.presentationGroups || []
  const componentsById = new Map(components.map((component) => [component.id, component]))
  if (componentsById.size !== components.length) throw new Error('Catalog component ids must be unique')

  const membership = new Map()
  const resolvedGroups = new Map()
  for (const group of groups) {
    if (!group?.id || !Array.isArray(group.componentIds) || group.componentIds.length < 2) {
      throw new Error('Presentation groups need an id and at least two componentIds')
    }
    if (componentsById.has(group.id)) throw new Error(`Presentation group id collides with component id: ${group.id}`)
    const groupComponents = group.componentIds.map((id) => {
      const component = componentsById.get(id)
      if (!component) throw new Error(`${group.id}: missing presentation component ${id}`)
      if (membership.has(id)) throw new Error(`${id}: component belongs to more than one presentation group`)
      membership.set(id, group.id)
      return component
    })
    const repositories = new Set(groupComponents.map((component) => component.repository))
    const refs = new Set(groupComponents.map((component) => component.ref))
    if (repositories.size !== 1 || refs.size !== 1) {
      throw new Error(`${group.id}: grouped components must share one repository and pinned ref`)
    }
    resolvedGroups.set(group.id, groupedPackage(group, groupComponents))
  }

  const emittedGroups = new Set()
  const listings = []
  for (const component of components) {
    const groupId = membership.get(component.id)
    if (!groupId) {
      listings.push(component)
      continue
    }
    if (emittedGroups.has(groupId)) continue
    listings.push(resolvedGroups.get(groupId))
    emittedGroups.add(groupId)
  }

  return {
    components,
    listings,
    groups: [...resolvedGroups.values()],
    groupedComponentIds: new Set(membership.keys()),
  }
}
