const state = {
  packages: [],
  catalogComponents: new Map(),
  candidates: [],
  projects: new Map(),
  runRecords: [],
  collections: [],
  community: { sources: [], discussions: [] },
  query: '',
  category: 'all',
  kind: 'all',
  install: 'all',
  channel: 'all',
  sort: 'featured',
  view: 'grid',
  featuredMode: 'stars',
  authorsExpanded: false,
  marketLayer: 'plugin',
  scope: 'all',
  snapshot: '',
  visible: 24,
}

const elements = {
  list: document.querySelector('#catalog-list'),
  spotlight: document.querySelector('#spotlight-side'),
  featured: document.querySelector('#featured-list'),
  featuredRail: document.querySelector('#featured-rail'),
  featuredPrevious: document.querySelector('#featured-previous'),
  featuredNext: document.querySelector('#featured-next'),
  workshopModes: document.querySelector('#workshop-modes'),
  collections: document.querySelector('#collection-list'),
  discussions: document.querySelector('#discussion-list'),
  authors: document.querySelector('#author-list'),
  authorSummary: document.querySelector('#author-summary'),
  authorToggle: document.querySelector('#author-toggle'),
  count: document.querySelector('#result-count'),
  empty: document.querySelector('#empty-state'),
  search: document.querySelector('#search'),
  kind: document.querySelector('#kind-filter'),
  install: document.querySelector('#install-filter'),
  channel: document.querySelector('#channel-filter'),
  sort: document.querySelector('#sort-order'),
  categories: document.querySelector('#category-filters'),
  scope: document.querySelector('#catalog-scope'),
  marketLayers: document.querySelector('#market-layer-options'),
  marketLayerDescription: document.querySelector('#market-layer-description'),
  advancedFilter: document.querySelector('#advanced-filter'),
  activeFilterCount: document.querySelector('#active-filter-count'),
  filterPanel: document.querySelector('.filter-panel'),
  ecosystemCount: document.querySelector('[data-ecosystem-count]'),
  featuredTabs: document.querySelector('#featured-tabs'),
  catalogShell: document.querySelector('.catalog-shell'),
  results: document.querySelector('.results-panel'),
  dialog: document.querySelector('#package-dialog'),
  dialogContent: document.querySelector('#dialog-content'),
  toast: document.querySelector('#toast'),
  pagination: document.querySelector('#catalog-pagination'),
  renderedCount: document.querySelector('#rendered-count'),
  filteredCount: document.querySelector('#filtered-count'),
  loadMore: document.querySelector('#load-more'),
}

let masonryObserver
let masonryFrame = 0

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

const t = (key) => window.DSHHub.t(key)
const locale = () => window.DSHHub.locale
const formatText = (key, values = {}) => Object.entries(values)
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), t(key))

const detailUrl = (pkg) => `${pkg.repository}/tree/${pkg.ref}${pkg.repositoryPath || ''}`

const anonymousAuthorNames = new Set(['anonymous', 'dsh-hub maintainers', 'omdsh maintainers'])

function isAnonymousAuthor(author) {
  return anonymousAuthorNames.has(String(author?.name || '').trim().toLocaleLowerCase('en-US'))
}

function authorDisplayName(author) {
  return isAnonymousAuthor(author) ? t('authors.anonymous') : author.name
}

function authorIdentity(author) {
  return String(author?.name || '').trim().toLocaleLowerCase('en-US')
}

function githubProfileUrl(author) {
  try {
    const url = new URL(author?.url)
    const segments = url.pathname.split('/').filter(Boolean)
    if (url.hostname !== 'github.com' || segments.length !== 1 || segments[0] === 'orgs') return ''
    return `https://github.com/${segments[0]}`
  } catch {
    return ''
  }
}

function authorLink(author) {
  const name = escapeHtml(authorDisplayName(author))
  return isAnonymousAuthor(author)
    ? `<span class="anonymous-author">${name}</span>`
    : `<button class="author-inline" type="button" data-open-author="${escapeHtml(authorIdentity(author))}">${name}</button>`
}

function avatarUrl(pkg) {
  if (isAnonymousAuthor(pkg.author)) return ''
  const profile = githubProfileUrl(pkg.author)
  if (!profile) return ''
  return `https://avatars.githubusercontent.com/${encodeURIComponent(profile.split('/').at(-1))}?size=80`
}

function commandPreview(command) {
  const firstLine = command.split('\n').find((line) => line.trim()) || command
  return firstLine.trim().replaceAll(/\s+/g, ' ')
}

const projectKindSymbols = {
  skill: '✦',
  mcp: '⇄',
  extension: '⌘',
  channel: '⌁',
  ui: '▣',
  adapter: '↔',
  manager: '▦',
  toolkit: '◇',
}

function projectMedia(pkg) {
  return state.projects.get(pkg.id)?.media || null
}

function projectMediaAsset(pkg, format = 'cover') {
  const media = projectMedia(pkg)
  if (!media) return null
  return format === 'icon'
    ? media.icon || media.cover || media.screenshots?.[0] || null
    : media.cover || media.screenshots?.[0] || media.icon || null
}

function projectVisual(pkg, format = 'cover', { decorative = true } = {}) {
  const copy = packageText(pkg)
  const asset = projectMediaAsset(pkg, format)
  const symbol = projectKindSymbols[pkg.kind] || '◇'
  return {
    state: asset ? 'declared' : 'generated',
    content: `
      <span class="project-visual-fallback" aria-hidden="true">
        <span class="project-visual-symbol">${escapeHtml(symbol)}</span>
        <span class="project-visual-kind">${escapeHtml(kindLabel(pkg.kind))}</span>
      </span>
      ${asset ? `<img class="project-media-image" src="${escapeHtml(asset.url)}" alt="${decorative ? '' : escapeHtml(copy.name)}" loading="lazy" decoding="async" data-project-media>` : ''}`,
  }
}

function authorMark(pkg, className = '') {
  const initial = [...authorDisplayName(pkg.author)][0]?.toLocaleUpperCase(locale() === 'zh' ? 'zh-CN' : 'en-US') || 'D'
  if (isAnonymousAuthor(pkg.author)) {
    return `<span class="author-fallback author-anonymous ${escapeHtml(className)}" aria-hidden="true">?</span>`
  }
  const avatar = avatarUrl(pkg)
  if (avatar) {
    return `<img class="author-avatar ${escapeHtml(className)}" src="${escapeHtml(avatar)}" alt="" width="24" height="24" loading="lazy" data-avatar data-avatar-fallback="${escapeHtml(initial)}">`
  }
  return `<span class="author-fallback ${escapeHtml(className)}" aria-hidden="true">${escapeHtml(initial)}</span>`
}

function packageText(pkg) {
  const translation = locale() === 'en' ? window.DSHHub.i18n?.packages?.[pkg.id] : null
  return {
    name: translation?.name || pkg.name,
    description: translation?.description || pkg.description,
    installLabel: translation?.installLabel || pkg.install.label,
    installNote: translation?.installNote ?? pkg.install.note,
    compatibility: translation?.compatibility || pkg.compatibility || t('dialog.seeProject'),
  }
}

function runTaskTitle(record) {
  return locale() === 'en' ? record.checks.task.translations.en : record.checks.task.title
}

function runRecordRow(record) {
  return `<article class="run-record">
    <div class="run-record-main">
      <span>${escapeHtml(record.environment.harnessSnapshot)} · ${escapeHtml(record.environment.profile)} / ${escapeHtml(record.environment.platform)}</span>
      <strong>${escapeHtml(runTaskTitle(record))}</strong>
      <small>${escapeHtml(t('project.runStagesPassed'))}</small>
    </div>
    <div class="run-record-proof">
      ${record.reproduces ? `<span class="run-reproduced">${escapeHtml(t('project.reproduced'))}</span>` : ''}
      <a href="${escapeHtml(record.evidenceUrl)}" rel="noreferrer">@${escapeHtml(record.verifier.github)} · ${escapeHtml(formatDate(record.verifiedAt, 'long'))} ↗</a>
    </div>
  </article>`
}

function collectionText(collection) {
  const translation = locale() === 'en' ? collection.translations?.en : null
  return {
    title: translation?.title || collection.title,
    summary: translation?.summary || collection.summary,
  }
}

function categoryLabel(category) {
  return t(`categories.${category}`) === `categories.${category}` ? category : t(`categories.${category}`)
}

function kindLabel(kind) {
  return t(`kinds.${kind}`) === `kinds.${kind}` ? kind : t(`kinds.${kind}`)
}

function statusLabel(status) {
  return t(`statuses.${status}`) === `statuses.${status}` ? status : t(`statuses.${status}`)
}

function projectMarketLayer(pkg) {
  return pkg.marketLayer || 'plugin'
}

function marketLayerLabel(layer) {
  return t(`market.layer.${layer}`)
}

function marketLayerDescription(layer) {
  return t(`market.description.${layer}`)
}

function presentationLabel(presentation) {
  const key = `candidates.presentation.${presentation}`
  const translated = t(key)
  return translated === key ? presentation : translated
}

function declarationLabel(declaration) {
  const key = `candidates.declaration.${declaration}`
  const translated = t(key)
  return translated === key ? declaration : translated
}

function formatDate(value, style = 'short') {
  const language = locale() === 'zh' ? 'zh-CN' : 'en-US'
  const options = style === 'long'
    ? { year: 'numeric', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric' }
  return new Intl.DateTimeFormat(language, { ...options, timeZone: 'Asia/Shanghai' }).format(new Date(value))
}

function installGroup(type) {
  if (type === 'none') return 'none'
  if (type === 'candidate') return 'pending'
  if (type === 'profile-bundle') return 'transactional'
  if (type === 'repository-plugin') return 'managed'
  return 'guided'
}

function integrationProtocol(pkg) {
  if (pkg.install.protocol) return pkg.install.protocol
  if (pkg.install.type === 'profile-bundle') return 'harness-profile'
  if (pkg.install.type === 'repository-plugin') return 'harness-repository'
  return 'third-party'
}

function integrationLabel(pkg) {
  if (pkg.install.type === 'profile-bundle') return t('install.backend.officialProfile')
  if (pkg.install.type === 'repository-plugin') return t('install.backend.officialRepository')
  return integrationProtocol(pkg) === 'harness-cordis'
    ? t('install.officialCordis')
    : t('install.guidedCompatibility')
}

function packageAccessState(pkg) {
  const state = pkg.workshop?.admission?.state
  if (state === 'registry-admitted') return 'registry'
  if (state === 'verification-passed-review-pending') return 'verified-pending'
  if (state === 'guided-evidence-passed') return 'guided-verified'
  if (state === 'verification-blocked') return 'blocked'
  return 'source-only'
}

function installFilterGroup(pkg) {
  const access = packageAccessState(pkg)
  if (['verified-pending', 'blocked'].includes(access)) return 'pending'
  if (['guided-verified', 'source-only'].includes(access)) return 'guided'
  return installGroup(pkg.install.type)
}

function catalogAccessLabel(pkg) {
  if (projectMarketLayer(pkg) !== 'plugin') return marketLayerLabel(projectMarketLayer(pkg))
  const access = packageAccessState(pkg)
  if (access === 'registry') return t('access.registry')
  if (access === 'verified-pending') return t('access.verifiedPending')
  if (access === 'guided-verified') return t('access.guidedVerified')
  if (access === 'blocked') return t('access.blocked')
  return t('access.sourceOnly')
}

function omdshCommand(pkg) {
  return installGroup(pkg.install.type) === 'guided'
    ? `omdsh workshop inspect ${pkg.id} --profile web`
    : `omdsh workshop install ${pkg.id} --profile web --enable`
}

function omdshActionLabel(pkg) {
  if (installGroup(pkg.install.type) !== 'guided') return t('install.withOmdsh')
  return integrationProtocol(pkg) === 'harness-cordis'
    ? t('install.viewOfficialSdkGuide')
    : t('install.viewIntegrationGuide')
}

function projectStars(pkg) {
  return Number(pkg.discovery?.stars || 0)
}

function commitUpdatedAt(pkg) {
  return pkg.discovery?.commitUpdatedAt || pkg.updatedAt
}

function installBackend(pkg) {
  if (projectMarketLayer(pkg) !== 'plugin') return t('management.none')
  if (pkg.install.type === 'profile-bundle') return t('install.backend.officialProfile')
  if (pkg.install.type === 'repository-plugin') return t('install.backend.officialRepository')
  if (integrationProtocol(pkg) === 'harness-cordis') return t('install.backend.officialCordis')
  return t('install.backend.none')
}

function integrationRequirement(pkg) {
  if (projectMarketLayer(pkg) !== 'plugin') return t('market.informationalOnly')
  if (pkg.install.type === 'profile-bundle') return t('install.requirement.officialCommand')
  if (pkg.install.type === 'repository-plugin') return t('install.requirement.officialRepository')
  if (integrationProtocol(pkg) === 'harness-cordis') return t('install.requirement.officialCordis')
  return t('install.requirement.guidedOnly')
}

function installMethodLabel(pkg) {
  if (projectMarketLayer(pkg) !== 'plugin') return t('market.informationalOnly')
  return integrationLabel(pkg)
}

function omdshInstallNote(pkg) {
  const group = installGroup(pkg.install.type)
  if (group !== 'guided') return t(`install.note.${group}`)
  return integrationProtocol(pkg) === 'harness-cordis'
    ? t('install.note.officialCordis')
    : t('install.note.thirdParty')
}

function managementLabel(type) {
  if (installGroup(type) === 'none') return t('management.none')
  return t(`management.${installGroup(type)}`)
}

function managementBoundary(type) {
  const group = installGroup(type)
  return {
    group,
    title: t(`managementBoundary.${group}.title`),
    description: t(`managementBoundary.${group}.description`),
  }
}

function projectRelease(pkg) {
  const project = state.projects.get(pkg.id)
  const release = project?.releases?.find((candidate) => candidate.id === project.latestRelease)
    || project?.releases?.[0]
    || {
      id: `${pkg.id}@${pkg.ref}`,
      version: pkg.version,
      channel: 'beta',
      ref: pkg.ref,
      updatedAt: pkg.updatedAt,
      license: pkg.license,
      listing: { state: 'review-required' },
      notice: pkg.install.note,
      source: { ref: pkg.ref },
      runtime: { kind: pkg.kind },
      management: { recoveryScope: 'none' },
      capabilities: {},
      risk: {
        level: 'unknown',
        facts: {
          sourcePinned: false,
          vulnerabilityScan: 'unknown',
          permissions: 'unknown',
          nativeCode: 'unknown',
          installScripts: 'unknown',
        },
      },
      dependencies: [],
      relations: [],
    }
  return { project, release }
}

function releaseChannel(pkg) {
  if (pkg.candidate) return null
  return projectRelease(pkg).release?.channel || 'beta'
}

function candidatePackage(candidate) {
  return {
    id: candidate.id,
    name: candidate.displayName,
    description: candidate.summary,
    kind: candidate.kind,
    category: candidate.category,
    tags: candidate.tags,
    author: candidate.author,
    repository: candidate.source.repository,
    repositoryPath: candidate.source.path,
    ref: candidate.source.ref,
    updatedAt: candidate.updatedAt,
    version: candidate.declaration.version || undefined,
    license: '',
    status: 'candidate',
    featured: false,
    install: { type: 'candidate', label: '', command: '' },
    candidate: true,
    candidateData: candidate,
  }
}

function marketProject(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    kind: project.kind,
    category: project.category,
    tags: project.tags,
    author: project.author,
    repository: project.source.repository,
    repositoryPath: project.source.path || '',
    ref: project.source.ref,
    updatedAt: project.updatedAt,
    version: project.version || undefined,
    license: project.license,
    status: 'ecosystem',
    featured: project.featured,
    discovery: project.discovery,
    marketLayer: project.layer,
    marketData: project,
    compatibility: marketLayerDescription(project.layer),
    install: {
      type: 'none',
      protocol: 'market-layer',
      label: '',
      command: '',
      note: project.registry.reason,
    },
  }
}

function catalogPresentation(index) {
  const components = index.packages || []
  const groups = index.presentationGroups || []
  const componentsById = new Map(components.map((component) => [component.id, component]))
  const membership = new Map()
  const resolvedGroups = new Map()

  for (const group of groups) {
    const members = group.componentIds.map((id) => {
      const component = componentsById.get(id)
      if (!component) throw new Error(`${group.id}: missing presentation component ${id}`)
      if (membership.has(id)) throw new Error(`${id}: duplicate presentation group membership`)
      membership.set(id, group.id)
      return component
    })
    const repositories = new Set(members.map((component) => component.repository))
    const refs = new Set(members.map((component) => component.ref))
    if (members.length < 2 || repositories.size !== 1 || refs.size !== 1) {
      throw new Error(`${group.id}: invalid presentation group`)
    }
    const base = members[0]
    const componentCounts = Object.fromEntries([...new Set(members.map((component) => component.kind))]
      .sort()
      .map((kind) => [kind, members.filter((component) => component.kind === kind).length]))
    resolvedGroups.set(group.id, {
      ...base,
      ...group,
      repositoryPath: group.repositoryPath || '',
      version: group.version || (members.every((component) => component.version === base.version) ? base.version : undefined),
      license: group.license || (members.every((component) => component.license === base.license) ? base.license : t('factValue.unknown')),
      status: group.status || (members.every((component) => component.status === base.status) ? base.status : 'prototype'),
      featured: group.featured ?? members.some((component) => component.featured),
      install: {
        ...base.install,
        label: group.installLabel || t('market.viewSource'),
        source: base.repository,
        command: base.repository,
        note: group.installNote,
      },
      workshop: {
        manifest: {
          status: members.every((component) => component.workshop?.manifest?.status === 'valid') ? 'valid' : 'legacy-evidence',
          source: `${members.length} component manifests`,
          schema: 'omdsh-workshop-package/v1',
        },
        install: {
          mode: 'guided',
          adapter: 'third-party',
          seamless: { state: 'unsupported', reason: 'presentation-group-is-not-an-install-unit' },
          failureIsolation: { state: 'unknown', policy: 'manual', reason: 'verified-per-component' },
        },
        lifecycle: { hotReload: { state: 'unknown', activation: 'unknown', reason: 'verified-per-component' } },
        integration: { protocol: 'third-party', artifact: `${members.length} independently reviewed components`, mcp: null },
        admission: { route: 'package-json-manifest', state: 'manifest-ready-for-tests' },
      },
      presentationGroup: {
        componentIds: members.map((component) => component.id),
        componentCounts,
        components: members,
      },
    })
  }

  const emitted = new Set()
  const listings = []
  for (const component of components) {
    const groupId = membership.get(component.id)
    if (!groupId) listings.push(component)
    else if (!emitted.has(groupId)) {
      listings.push(resolvedGroups.get(groupId))
      emitted.add(groupId)
    }
  }
  return { components, listings }
}

function factValue(value) {
  const key = `factValue.${String(value)}`
  const translated = t(key)
  return translated === key ? String(value) : translated
}

function workshopCapabilities(pkg) {
  return pkg.workshop || {
    manifest: { status: 'legacy-evidence', source: 'unknown', schema: null },
    install: {
      mode: 'guided',
      seamless: { state: 'unknown', reason: 'not-declared' },
      failureIsolation: { state: 'unknown', policy: 'manual', reason: 'not-declared' },
    },
    lifecycle: { hotReload: { state: 'unknown', activation: 'unknown', reason: 'not-declared' } },
    integration: { protocol: integrationProtocol(pkg), artifact: 'unknown', mcp: null },
    admission: { route: 'legacy-compatibility-map', state: 'needs-package-manifest' },
  }
}

function capabilityChip(label, fact) {
  return `<span class="capability-chip state-${escapeHtml(fact.state)}"><small>${escapeHtml(label)}</small><strong>${escapeHtml(factValue(fact.state))}</strong></span>`
}

function capabilityMatrix(pkg) {
  const capabilities = workshopCapabilities(pkg)
  const seamless = capabilities.install.seamless
  const isolation = capabilities.install.failureIsolation
  const hotReload = capabilities.lifecycle.hotReload
  const mcpVersion = capabilities.integration.mcp?.protocolVersions?.join(', ')
  return `<section class="project-capability-matrix">
    <div class="project-capability-heading"><h3>${escapeHtml(t('project.capabilitiesTitle'))}</h3><p>${escapeHtml(t('project.capabilitiesDescription'))}</p></div>
    <div class="project-capability-grid">
      <article class="state-${escapeHtml(seamless.state)}"><span>${escapeHtml(t('project.seamlessInstall'))}</span><strong>${escapeHtml(factValue(seamless.state))}</strong><small>${escapeHtml(factValue(seamless.reason))}</small></article>
      <article class="state-${escapeHtml(isolation.state)}"><span>${escapeHtml(t('project.failureIsolation'))}</span><strong>${escapeHtml(factValue(isolation.state))}</strong><small>${escapeHtml(factValue(isolation.policy))}</small></article>
      <article class="state-${escapeHtml(hotReload.state)}"><span>${escapeHtml(t('project.hotReload'))}</span><strong>${escapeHtml(factValue(hotReload.state))}</strong><small>${escapeHtml(factValue(hotReload.activation))}</small></article>
      <article><span>${escapeHtml(t('project.integrationProtocol'))}</span><strong>${escapeHtml(factValue(capabilities.integration.protocol))}</strong><small>${escapeHtml(mcpVersion ? `MCP ${mcpVersion}` : capabilities.integration.artifact)}</small></article>
      <article class="state-${escapeHtml(capabilities.manifest.status === 'valid' ? 'declared' : 'unknown')}"><span>${escapeHtml(t('project.communityAdmission'))}</span><strong>${escapeHtml(factValue(capabilities.admission.state))}</strong><small>${escapeHtml(factValue(capabilities.admission.route))}</small></article>
    </div>
  </section>`
}

function presentationGroupSection(pkg) {
  const group = pkg.presentationGroup
  if (!group) return ''
  const counts = Object.entries(group.componentCounts)
    .map(([kind, count]) => formatText('project.componentKindCount', { count, kind: kindLabel(kind) }))
    .join(' · ')
  return `<section class="suite-components">
    <div class="suite-components-heading">
      <div><span>${escapeHtml(t('project.components'))}</span><strong>${escapeHtml(formatText('project.componentCount', { count: group.components.length }))}</strong></div>
      <p>${escapeHtml(t('project.componentsBoundary'))}</p>
    </div>
    <div class="suite-component-counts">${escapeHtml(counts)}</div>
    <div class="suite-component-grid">
      ${group.components.map((component) => `<button type="button" class="suite-component" data-open-package="${escapeHtml(component.id)}">
        <span class="suite-component-symbol" aria-hidden="true">${escapeHtml(projectKindSymbols[component.kind] || '◇')}</span>
        <span><strong>${escapeHtml(packageText(component).name)}</strong><small>${escapeHtml(kindLabel(component.kind))} · ${escapeHtml(component.repositoryPath)}</small></span>
        <span class="suite-component-state">${escapeHtml(factValue(component.workshop?.admission?.state || 'needs-package-manifest'))}</span>
      </button>`).join('')}
    </div>
  </section>`
}

function pushOverlayRoute(kind, value) {
  history.pushState({ workshopOverlay: true }, '', `#${kind}=${encodeURIComponent(value)}`)
}

function replaceOverlayRoute(kind, value) {
  history.replaceState({ workshopOverlay: true }, '', `#${kind}=${encodeURIComponent(value)}`)
}

function closeOverlay() {
  if (history.state?.workshopOverlay) {
    history.back()
    return
  }
  if (elements.dialog.open) elements.dialog.close()
  history.replaceState(null, '', `${location.pathname}${location.search}`)
}

function syncOverlayRoute() {
  const params = new URLSearchParams(location.hash.slice(1))
  const requested = params.get('package')
  const requestedCollection = params.get('collection')
  const requestedAuthor = params.get('author')
  const requestedCandidate = params.get('candidate')
  if (requested) openPackage(requested, false)
  else if (requestedCollection) openCollection(requestedCollection, false)
  else if (requestedAuthor) openAuthor(requestedAuthor, false)
  else if (requestedCandidate) openCandidate(requestedCandidate, false)
  else if (elements.dialog.dataset.returnAuthorUrl) {
    const returnAuthorUrl = elements.dialog.dataset.returnAuthorUrl
    pushOverlayRoute('author', returnAuthorUrl)
    openAuthor(returnAuthorUrl, false)
  } else if (elements.dialog.open) elements.dialog.close()
}

function returnToAuthor() {
  const authorUrl = elements.dialog.dataset.returnAuthorUrl
  if (!authorUrl) return
  replaceOverlayRoute('author', authorUrl)
  openAuthor(authorUrl, false)
}

function setActiveSection(sectionId) {
  document.querySelectorAll('.site-nav a[href^="#"], .workshop-nav a[href^="#"]').forEach((link) => {
    const active = link.getAttribute('href') === `#${sectionId}`
    if (active) {
      link.setAttribute('aria-current', link.closest('.site-nav') ? 'page' : 'location')
    } else {
      link.removeAttribute('aria-current')
    }
  })
}

function bindSectionNavigation() {
  const sectionIds = ['discover', 'collections', 'community', 'catalog', 'authors']
  document.querySelectorAll('.site-nav a[href^="#"], .workshop-nav a[href^="#"]').forEach((link) => {
    link.addEventListener('click', () => setActiveSection(link.hash.slice(1)))
  })
  const observer = new IntersectionObserver((entries) => {
    const current = entries
      .filter((entry) => entry.isIntersecting)
      .sort((left, right) => Math.abs(left.boundingClientRect.top) - Math.abs(right.boundingClientRect.top))[0]
    if (current) setActiveSection(current.target.id)
  }, { rootMargin: '-22% 0px -68% 0px', threshold: 0 })
  sectionIds.forEach((id) => {
    const section = document.getElementById(id)
    if (section) observer.observe(section)
  })
  const requested = location.hash.slice(1)
  setActiveSection(sectionIds.includes(requested) ? requested : 'discover')
}

function activateProjectTab(tab) {
  elements.dialog.dataset.projectTab = tab
  elements.dialogContent.querySelectorAll('[data-project-tab]').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.projectTab === tab))
  })
  elements.dialogContent.querySelectorAll('[data-project-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.projectPanel !== tab
  })
}

function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase(locale() === 'zh' ? 'zh-CN' : 'en-US')
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function searchTokens(value) {
  return normalizeSearch(value).split(/\s+/).filter(Boolean)
}

function searchableText(pkg) {
  const translated = window.DSHHub.i18n?.packages?.[pkg.id] || {}
  const componentText = (pkg.presentationGroup?.components || [])
    .flatMap((component) => [component.id, component.name, component.description, component.kind, ...(component.tags || [])])
  return normalizeSearch([
    pkg.id,
    pkg.name,
    pkg.description,
    translated.name,
    translated.description,
    pkg.kind,
    pkg.category,
    pkg.author.name,
    pkg.repository,
    marketLayerLabel(projectMarketLayer(pkg)),
    kindLabel(pkg.kind),
    pkg.category ? categoryLabel(pkg.category) : '',
    ...pkg.tags,
    ...componentText,
  ].filter(Boolean).join(' '))
}

function scopedPackages() {
  const selected = state.marketLayer === 'all'
    ? state.packages
    : state.packages.filter((pkg) => projectMarketLayer(pkg) === state.marketLayer)
  const candidates = ['all', 'plugin'].includes(state.marketLayer) ? state.candidates : []
  const reviewed = selected.filter((pkg) => pkg.status !== 'discovery')
  const discovered = selected.filter((pkg) => pkg.status === 'discovery')
  if (state.scope === 'reviewed') return reviewed
  if (state.scope === 'candidates') return [...discovered, ...candidates]
  return [...selected, ...candidates]
}

function filteredPackages() {
  const query = searchTokens(state.query)
  const packages = scopedPackages().filter((pkg) => {
    if (query.length > 0) {
      const text = searchableText(pkg)
      if (!query.every((token) => text.includes(token))) return false
    }
    if (state.category !== 'all' && pkg.category !== state.category) return false
    if (state.kind !== 'all'
      && pkg.kind !== state.kind
      && !(pkg.presentationGroup?.components || []).some((component) => component.kind === state.kind)) return false
    if (state.install !== 'all' && installFilterGroup(pkg) !== state.install) return false
    if (state.channel !== 'all' && releaseChannel(pkg) !== state.channel) return false
    return true
  })

  return packages.sort((a, b) => {
    if (state.sort === 'name') return packageText(a).name.localeCompare(packageText(b).name, locale() === 'zh' ? 'zh-CN' : 'en')
    if (state.sort === 'updated') return new Date(commitUpdatedAt(b)) - new Date(commitUpdatedAt(a))
    return Number(Boolean(b.featured)) - Number(Boolean(a.featured))
      || new Date(b.updatedAt) - new Date(a.updatedAt)
      || packageText(a).name.localeCompare(packageText(b).name, locale() === 'zh' ? 'zh-CN' : 'en')
  })
}

function packageCard(pkg) {
  if (pkg.candidate) return candidateCard(pkg)
  const copy = packageText(pkg)
  const visualFormat = state.view === 'list' ? 'icon' : 'cover'
  const visual = projectVisual(pkg, visualFormat)
  const version = pkg.version ? `v${pkg.version}` : pkg.ref.slice(0, 7)
  const { release } = projectRelease(pkg)
  const access = packageAccessState(pkg)
  const guided = access === 'guided-verified'
  const verifiedPending = access === 'verified-pending'
  const sourceOnly = access === 'source-only'
  const informational = projectMarketLayer(pkg) !== 'plugin'
  const installBlocked = access === 'blocked'
  return `
    <article class="package-card market-layer-${escapeHtml(projectMarketLayer(pkg))}">
      <button class="package-thumb project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" type="button" data-media-state="${visual.state}" data-visual-format="${visualFormat}" data-open-package="${escapeHtml(pkg.id)}" aria-label="${escapeHtml(formatText('row.open', { name: copy.name }))}">
        ${visual.content}
      </button>
      <div class="package-card-content">
        <div class="package-card-top">
          <div class="package-labels">
            <span>${escapeHtml(kindLabel(pkg.kind))}</span>
            ${pkg.category ? `<span>${escapeHtml(categoryLabel(pkg.category))}</span>` : ''}
            <span>${escapeHtml(catalogAccessLabel(pkg))}</span>
          </div>
          <span class="package-status">${escapeHtml(statusLabel(pkg.status))}</span>
        </div>
        <div class="package-card-copy">
          <button class="package-name" type="button" data-open-package="${escapeHtml(pkg.id)}">${escapeHtml(copy.name)}</button>
          <code>${escapeHtml(pkg.id)}</code>
          <p>${escapeHtml(copy.description)}</p>
        </div>
        <div class="package-byline">
          ${authorMark(pkg, 'classic-avatar')}
          ${authorLink(pkg.author)}
          <span>${escapeHtml(version)}</span>
          <span>${escapeHtml(pkg.license)}</span>
          <time datetime="${escapeHtml(pkg.updatedAt)}">${escapeHtml(formatDate(pkg.updatedAt))} ${escapeHtml(t('row.updated'))}</time>
        </div>
        <div class="package-compatibility">
          <span>${escapeHtml(t('row.compatibility'))}</span>
          <strong title="${escapeHtml(copy.compatibility)}">${escapeHtml(copy.compatibility)}</strong>
        </div>
        ${projectMarketLayer(pkg) === 'plugin' ? pkg.presentationGroup ? `<div class="package-component-summary">
          ${Object.entries(pkg.presentationGroup.componentCounts).map(([kind, count]) => `<span><strong>${escapeHtml(count)}</strong><small>${escapeHtml(kindLabel(kind))}</small></span>`).join('')}
        </div>` : `<div class="package-capability-strip">
          ${capabilityChip(t('project.seamlessInstall'), workshopCapabilities(pkg).install.seamless)}
          ${capabilityChip(t('project.failureIsolation'), workshopCapabilities(pkg).install.failureIsolation)}
          ${capabilityChip(t('project.hotReload'), workshopCapabilities(pkg).lifecycle.hotReload)}
        </div>` : ''}
      </div>
        <div class="package-card-footer">
        ${informational ? `<a class="install-preview market-source-preview" href="${escapeHtml(detailUrl(pkg))}">
          <span>
            <strong>${escapeHtml(t('market.viewSource'))}</strong>
            <code>${escapeHtml(t('market.informationalOnly'))}</code>
          </span>
          <span class="copy-label">↗</span>
        </a>` : installBlocked ? `<div class="install-preview install-preview-blocked"><span><strong>${escapeHtml(t('project.installUnavailable'))}</strong><code>${escapeHtml(t('access.blocked'))}</code></span></div>` : verifiedPending ? `<div class="install-preview install-preview-blocked"><span><strong>${escapeHtml(t('install.awaitingApproval'))}</strong><code>${escapeHtml(t('access.verifiedPending'))}</code></span></div>` : guided ? `<a class="install-preview" href="${escapeHtml(detailUrl(pkg))}">
          <span>
            <strong>${escapeHtml(t('install.viewVerifiedGuide'))}</strong>
            <code>${escapeHtml(pkg.repository.replace('https://github.com/', ''))}</code>
          </span>
          <span class="copy-label">↗</span>
        </a>` : sourceOnly ? `<a class="install-preview" href="${escapeHtml(detailUrl(pkg))}">
          <span>
            <strong>${escapeHtml(t('install.viewSourceOnly'))}</strong>
            <code>${escapeHtml(pkg.repository.replace('https://github.com/', ''))}</code>
          </span>
          <span class="copy-label">↗</span>
        </a>` : `<button class="install-preview" type="button" data-copy-install="${escapeHtml(pkg.id)}">
          <span>
            <strong>${escapeHtml(omdshActionLabel(pkg))}</strong>
            <code>${escapeHtml(commandPreview(omdshCommand(pkg)))}</code>
          </span>
          <span class="copy-label">${escapeHtml(t('dialog.copy'))}</span>
        </button>`}
        <div class="package-card-links">
          <button type="button" data-copy-subscribe="${escapeHtml(pkg.id)}">${escapeHtml(t('row.subscribe'))}</button>
          <a href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('row.source'))} ↗</a>
          <button type="button" data-open-package="${escapeHtml(pkg.id)}" aria-label="${escapeHtml(formatText('row.open', { name: copy.name }))}">${escapeHtml(t('row.details'))}</button>
        </div>
      </div>
    </article>`
}

function candidateCard(pkg) {
  const candidate = pkg.candidateData
  const copy = packageText(pkg)
  const declarations = candidate.declaration.types
  const version = candidate.declaration.version ? `v${candidate.declaration.version}` : pkg.ref.slice(0, 7)
  const visualFormat = state.view === 'list' ? 'icon' : 'cover'
  const visual = projectVisual(pkg, visualFormat)
  return `
    <article class="package-card candidate-card">
      <button class="package-thumb project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" type="button" data-media-state="${visual.state}" data-visual-format="${visualFormat}" data-open-candidate="${escapeHtml(pkg.id)}" aria-label="${escapeHtml(formatText('row.open', { name: copy.name }))}">
        ${visual.content}
      </button>
      <div class="package-card-content">
        <div class="package-card-top">
          <div class="package-labels">
            <span>${escapeHtml(kindLabel(pkg.kind))}</span>
            <span>${escapeHtml(presentationLabel(candidate.presentation))}</span>
            ${declarations.slice(0, 1).map((item) => `<span>${escapeHtml(declarationLabel(item))}</span>`).join('')}
          </div>
          <span class="package-status candidate-status">${escapeHtml(t('candidates.pending'))}</span>
        </div>
        <div class="package-card-copy">
          <button class="package-name" type="button" data-open-candidate="${escapeHtml(pkg.id)}">${escapeHtml(copy.name)}</button>
          <code>${escapeHtml(pkg.repository.replace('https://github.com/', ''))}${escapeHtml(pkg.repositoryPath || '')}</code>
          <p>${escapeHtml(copy.description)}</p>
        </div>
        <div class="package-byline candidate-byline">
          ${authorMark(pkg, 'classic-avatar')}
          <span>${escapeHtml(authorDisplayName(pkg.author))}</span>
          <span>${escapeHtml(version)}</span>
          <time datetime="${escapeHtml(pkg.updatedAt)}">${escapeHtml(formatDate(pkg.updatedAt))} ${escapeHtml(t('row.updated'))}</time>
        </div>
        <div class="candidate-evidence">
          <span>${escapeHtml(t('candidates.evidence'))}</span>
          <strong>${escapeHtml(declarations.length > 0 ? declarations.map(declarationLabel).join(' · ') : t('candidates.noManifest'))}</strong>
        </div>
      </div>
      <div class="package-card-footer candidate-footer">
        <div class="install-preview install-preview-blocked">
          <span><strong>${escapeHtml(t('candidates.notInstallable'))}</strong><code>${escapeHtml(t('candidates.reviewFirst'))}</code></span>
        </div>
        <div class="package-card-links">
          <a href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('row.source'))} ↗</a>
          <button type="button" data-open-candidate="${escapeHtml(pkg.id)}">${escapeHtml(t('candidates.viewEvidence'))}</button>
        </div>
      </div>
    </article>`
}

function renderCollections() {
  elements.collections.innerHTML = state.collections.map((collection) => {
    const projects = collection.items.map((item) => state.projects.get(item.projectId)).filter(Boolean)
    const copy = collectionText(collection)
    return `
      <article class="collection-card">
        <div class="collection-card-top">
          <span>${escapeHtml(formatText('collections.projectCount', { count: projects.length }))}</span>
          <span>${escapeHtml(t('collections.atomic'))}</span>
        </div>
        <h3>${escapeHtml(copy.title)}</h3>
        <p>${escapeHtml(copy.summary)}</p>
        <div class="collection-projects">
          ${projects.map((project) => `<button type="button" data-open-package="${escapeHtml(project.id)}">${escapeHtml(project.displayName)}</button>`).join('')}
        </div>
        <div class="collection-footer">
          <span>${escapeHtml(authorDisplayName(collection.author))}</span>
          <button type="button" data-open-collection="${escapeHtml(collection.id)}">${escapeHtml(t('collections.details'))}</button>
        </div>
      </article>`
  }).join('')
  if (state.collections.length === 0) {
    elements.collections.innerHTML = `<p class="section-empty">${escapeHtml(t('collections.empty'))}</p>`
  }
  elements.collections.setAttribute('aria-busy', 'false')
}

function discussionRow(item) {
  return `
    <a class="discussion-row" href="${escapeHtml(item.url)}">
      <span class="discussion-category">${escapeHtml(item.category)}</span>
      <span class="discussion-copy">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.author.login)} · ${escapeHtml(formatDate(item.updatedAt, 'long'))}</span>
      </span>
      <span class="discussion-facts">${escapeHtml(formatText('community.comments', { count: item.commentCount }))}${item.answered ? ` · ${escapeHtml(t('community.answered'))}` : ''}</span>
    </a>`
}

function renderCommunity() {
  const discussions = state.community.discussions || []
  if (discussions.length > 0) {
    elements.discussions.innerHTML = discussions.slice(0, 8).map(discussionRow).join('')
  } else {
    const enabled = (state.community.sources || []).some((source) => source.enabled)
    elements.discussions.innerHTML = `
      <div class="community-empty">
        <strong>${escapeHtml(t(enabled ? 'community.emptyTitle' : 'community.disabledTitle'))}</strong>
        <p>${escapeHtml(t(enabled ? 'community.emptyDescription' : 'community.disabledDescription'))}</p>
      </div>`
  }
  elements.discussions.setAttribute('aria-busy', 'false')
}

function renderAuthors() {
  const authors = new Map()
  let anonymousProjects = 0
  for (const pkg of state.packages) {
    if (isAnonymousAuthor(pkg.author)) {
      anonymousProjects += 1
      continue
    }
    const key = authorIdentity(pkg.author)
    const current = authors.get(key) || { author: pkg.author, projects: [] }
    if (!githubProfileUrl(current.author) && githubProfileUrl(pkg.author)) current.author = pkg.author
    current.projects.push(pkg)
    authors.set(key, current)
  }
  const rankedAuthors = [...authors.entries()]
    .sort(([, left], [, right]) => right.projects.length - left.projects.length || left.author.name.localeCompare(right.author.name))
  const attributedProjects = rankedAuthors.reduce((total, [, entry]) => total + entry.projects.length, 0)
  const visibleAuthors = state.authorsExpanded ? rankedAuthors : rankedAuthors.slice(0, 12)
  elements.authorSummary.textContent = formatText('authors.summary', {
    authors: rankedAuthors.length,
    projects: attributedProjects,
    anonymous: anonymousProjects,
  })
  elements.authors.innerHTML = visibleAuthors
    .map(([key, entry]) => `
      <button class="author-row" type="button" data-open-author="${escapeHtml(key)}">
        ${authorMark({ author: entry.author })}
        <span><strong>${escapeHtml(entry.author.name)}</strong><small>${escapeHtml(formatText(entry.projects.length === 1 ? 'authors.projectCountOne' : 'authors.projectCount', { count: entry.projects.length }))}</small></span>
      </button>`).join('')
  elements.authorToggle.hidden = rankedAuthors.length <= 12
  elements.authorToggle.setAttribute('aria-expanded', String(state.authorsExpanded))
  elements.authorToggle.textContent = formatText(state.authorsExpanded ? 'authors.showLess' : 'authors.showAll', { count: rankedAuthors.length })
  elements.authors.setAttribute('aria-busy', 'false')
}

function layoutMasonry() {
  if (state.view !== 'grid' || elements.list.hidden) return
  const styles = getComputedStyle(elements.list)
  const rowHeight = Number.parseFloat(styles.gridAutoRows)
  const rowGap = Number.parseFloat(styles.rowGap)
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return
  elements.list.querySelectorAll('.package-card').forEach((card) => {
    card.style.gridRowEnd = 'auto'
    const height = card.getBoundingClientRect().height
    const span = Math.max(1, Math.ceil((height + rowGap) / (rowHeight + rowGap)))
    card.style.gridRowEnd = `span ${span}`
  })
}

function scheduleMasonryLayout() {
  window.cancelAnimationFrame(masonryFrame)
  masonryFrame = window.requestAnimationFrame(layoutMasonry)
}

function refreshMasonryLayout() {
  masonryObserver?.disconnect()
  elements.list.querySelectorAll('.package-card').forEach((card) => {
    card.style.removeProperty('grid-row-end')
  })
  if (state.view !== 'grid') return
  if ('ResizeObserver' in window) {
    masonryObserver = new ResizeObserver(scheduleMasonryLayout)
    elements.list.querySelectorAll('.package-card').forEach((card) => masonryObserver.observe(card))
  }
  scheduleMasonryLayout()
}

function renderMarketLayers() {
  const counts = {
    all: state.packages.length,
    plugin: state.packages.filter((pkg) => projectMarketLayer(pkg) === 'plugin').length,
    infrastructure: state.packages.filter((pkg) => projectMarketLayer(pkg) === 'infrastructure').length,
    distribution: state.packages.filter((pkg) => projectMarketLayer(pkg) === 'distribution').length,
  }
  document.querySelectorAll('[data-market-layer]').forEach((button) => {
    const layer = button.dataset.marketLayer
    button.setAttribute('aria-pressed', String(layer === state.marketLayer))
    const count = button.querySelector('[data-market-layer-count]')
    if (count) count.textContent = String(counts[layer] || 0)
  })
  if (elements.marketLayerDescription) {
    elements.marketLayerDescription.textContent = marketLayerDescription(state.marketLayer)
  }
  if (elements.scope) {
    elements.scope.hidden = !['all', 'plugin'].includes(state.marketLayer)
  }
  if (elements.ecosystemCount) {
    elements.ecosystemCount.textContent = String(counts.infrastructure + counts.distribution)
  }
}

function renderAdvancedFilterState() {
  if (!elements.activeFilterCount) return
  const count = [state.install, state.channel, state.category]
    .filter((value) => value !== 'all').length
  elements.activeFilterCount.textContent = String(count)
  elements.activeFilterCount.hidden = count === 0
  elements.advancedFilter?.classList.toggle('has-active-filters', count > 0)
}

function render() {
  const packages = filteredPackages()
  const visiblePackages = packages.slice(0, state.visible)
  if (elements.catalogShell) elements.catalogShell.dataset.view = state.view
  elements.list.dataset.view = state.view
  elements.list.innerHTML = visiblePackages.map(packageCard).join('')
  elements.list.setAttribute('aria-busy', 'false')
  elements.count.textContent = String(packages.length)
  elements.empty.hidden = packages.length !== 0
  elements.list.hidden = packages.length === 0
  elements.renderedCount.textContent = String(visiblePackages.length)
  elements.filteredCount.textContent = String(packages.length)
  elements.pagination.hidden = packages.length === 0
  elements.loadMore.hidden = visiblePackages.length >= packages.length
  renderMarketLayers()
  renderAdvancedFilterState()
  refreshMasonryLayout()

  document.querySelectorAll('.category-filter').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.category === state.category))
  })
  document.querySelectorAll('[data-install-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.installView === state.install))
  })
  document.querySelectorAll('[data-catalog-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.catalogView === state.view))
  })
  document.querySelectorAll('[data-catalog-scope]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.catalogScope === state.scope))
  })
  const layerPackages = state.marketLayer === 'all'
    ? state.packages
    : state.packages.filter((pkg) => projectMarketLayer(pkg) === state.marketLayer)
  const layerCandidates = ['all', 'plugin'].includes(state.marketLayer) ? state.candidates : []
  document.querySelector('[data-scope-count="all"]').textContent = String(layerPackages.length + layerCandidates.length)
  document.querySelector('[data-scope-count="reviewed"]').textContent = String(layerPackages.filter((pkg) => pkg.status !== 'discovery').length)
  document.querySelector('[data-scope-count="candidates"]').textContent = String(layerPackages.filter((pkg) => pkg.status === 'discovery').length + layerCandidates.length)
}

function alignResultsToTop() {
  window.cancelAnimationFrame(alignResultsToTop.frame)
  alignResultsToTop.frame = window.requestAnimationFrame(() => {
    elements.results.scrollIntoView({ block: 'start', behavior: 'instant' })
  })
}

function updateFeaturedRail() {
  const maxScroll = Math.max(0, elements.featured.scrollWidth - elements.featured.clientWidth)
  const canPrevious = elements.featured.scrollLeft > 2
  const canNext = elements.featured.scrollLeft < maxScroll - 2
  elements.featuredRail.dataset.canPrevious = String(canPrevious)
  elements.featuredRail.dataset.canNext = String(canNext)
  elements.featuredPrevious.disabled = !canPrevious
  elements.featuredNext.disabled = !canNext
}

function scrollFeatured(direction) {
  const firstItem = elements.featured.querySelector('.featured-item')
  if (!firstItem) return
  const gap = Number.parseFloat(getComputedStyle(elements.featured).columnGap) || 12
  const distance = firstItem.getBoundingClientRect().width + gap
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  elements.featured.scrollBy({ left: direction * distance, behavior: reducedMotion ? 'auto' : 'smooth' })
}

function selectFeaturedPackages(packages, mode) {
  const byRecency = (a, b) => new Date(commitUpdatedAt(b)) - new Date(commitUpdatedAt(a))
    || a.id.localeCompare(b.id)
  if (mode === 'recent') return [...packages].sort(byRecency)

  const recoverable = packages
    .filter((pkg) => installGroup(pkg.install.type) === 'transactional')
    .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || byRecency(a, b))
  if (mode === 'recoverable') return recoverable

  return [...packages].sort((a, b) => projectStars(b) - projectStars(a) || byRecency(a, b))
}

function selectSpotlightPackages(packages) {
  const ranked = [...packages]
    .filter((pkg) => projectMarketLayer(pkg) === 'plugin'
      && pkg.discovery?.qualification === 'verified-plugin-contract'
      && !pkg.discovery?.archived)
    .sort((a, b) => projectStars(b) - projectStars(a)
      || new Date(commitUpdatedAt(b)) - new Date(commitUpdatedAt(a))
      || a.id.localeCompare(b.id))
  const repositories = new Set()

  return ranked.filter((pkg) => {
    const repository = pkg.repository.toLocaleLowerCase('en-US')
    if (repositories.has(repository)) return false
    repositories.add(repository)
    return true
  }).slice(0, 2)
}

function renderFeatured() {
  const packages = selectFeaturedPackages(state.packages, state.featuredMode).slice(0, 16)

  elements.featured.innerHTML = packages.length === 0
    ? `<p class="featured-lane-empty">${escapeHtml(t('featured.empty.recoverable'))}</p>`
    : packages.map((pkg) => {
    const copy = packageText(pkg)
    const visual = projectVisual(pkg, 'icon')
    return `
      <button class="featured-item" type="button" data-open-package="${escapeHtml(pkg.id)}">
        <span class="featured-icon project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" data-media-state="${visual.state}" data-visual-format="icon">
          ${visual.content}
        </span>
        <span class="featured-content">
          <span class="featured-meta">
            <span>${escapeHtml(kindLabel(pkg.kind))} · ${escapeHtml(catalogAccessLabel(pkg))}</span>
            <time datetime="${escapeHtml(commitUpdatedAt(pkg))}">${escapeHtml(formatDate(commitUpdatedAt(pkg)))}</time>
          </span>
          <strong>${escapeHtml(copy.name)}</strong>
          <span class="featured-description">${escapeHtml(copy.description)}</span>
          <span class="featured-author">${authorMark(pkg)}<span>${escapeHtml(authorDisplayName(pkg.author))}</span><span class="featured-stars">★ ${escapeHtml(projectStars(pkg))}</span></span>
        </span>
      </button>`
  }).join('')
  elements.featured.setAttribute('aria-busy', 'false')
  elements.featured.scrollLeft = 0
  elements.featuredTabs.querySelectorAll('[data-featured-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.featuredMode === state.featuredMode))
  })
  window.requestAnimationFrame(updateFeaturedRail)
}

function renderSpotlight() {
  const packages = selectSpotlightPackages(state.packages)

  elements.spotlight.innerHTML = packages.map((pkg) => {
    const copy = packageText(pkg)
    const visual = projectVisual(pkg)
    return `
      <button class="spotlight-project" type="button" data-open-package="${escapeHtml(pkg.id)}">
        <span class="spotlight-project-visual project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" data-media-state="${visual.state}" data-visual-format="cover">
          ${visual.content}
        </span>
        <span class="spotlight-project-copy">
          <span class="spotlight-project-meta">
            <span>${escapeHtml(kindLabel(pkg.kind))} · ${escapeHtml(catalogAccessLabel(pkg))}</span>
            <span class="spotlight-project-stars" title="${escapeHtml(t('spotlight.starsSnapshot'))}">★ ${escapeHtml(projectStars(pkg))}</span>
          </span>
          <strong>${escapeHtml(copy.name)}</strong>
          <span class="spotlight-project-description">${escapeHtml(copy.description)}</span>
          <span class="spotlight-project-author">${authorMark(pkg)}<span>${escapeHtml(authorDisplayName(pkg.author))}</span></span>
        </span>
      </button>`
  }).join('')
  elements.spotlight.setAttribute('aria-busy', 'false')
}

function renderWorkshopModes() {
  const modes = ['transactional', 'managed', 'guided']
  const counts = Object.fromEntries(modes.map((mode) => [
    mode,
    state.packages.filter((pkg) => installFilterGroup(pkg) === mode).length,
  ]))
  elements.workshopModes.innerHTML = modes.map((mode) => `
    <button class="workshop-mode mode-${escapeHtml(mode)}" type="button" data-install-view="${escapeHtml(mode)}" aria-pressed="${state.install === mode}">
      <span class="workshop-mode-count">${escapeHtml(counts[mode])}</span>
      <span class="workshop-mode-copy">
        <strong>${escapeHtml(t(`workshop.${mode}.title`))}</strong>
        <span>${escapeHtml(t(`workshop.${mode}.description`))}</span>
      </span>
      <span class="workshop-mode-action">${escapeHtml(t(`workshop.${mode}.action`))}</span>
    </button>`).join('')
  elements.workshopModes.setAttribute('aria-busy', 'false')
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
}

function renderFilters() {
  const available = scopedPackages()
  const categories = [...new Set(available.map((pkg) => pkg.category).filter(Boolean))]
  elements.categories.innerHTML = ['all', ...categories].map((category) => {
    const count = category === 'all'
      ? available.length
      : available.filter((pkg) => pkg.category === category).length
    return `<button class="category-filter" type="button" data-category="${escapeHtml(category)}" aria-pressed="${category === state.category}">${escapeHtml(categoryLabel(category))}<span>${count}</span></button>`
  }).join('')

  const kinds = [...new Set(available.map((pkg) => pkg.kind))]
  elements.kind.innerHTML = option('all', t('filters.allTypes'))
    + kinds.map((kind) => option(kind, kindLabel(kind))).join('')
  elements.install.innerHTML = [
    option('all', t('filters.allInstall')),
    option('transactional', t('filters.transactional')),
    option('managed', t('filters.managed')),
    option('guided', t('filters.guided')),
    option('pending', t('filters.pending')),
    option('none', t('filters.informational')),
  ].join('')
  elements.channel.innerHTML = [
    option('all', t('filters.allChannels')),
    option('stable', factValue('stable')),
    option('beta', factValue('beta')),
  ].join('')
  elements.sort.innerHTML = [
    option('featured', t('sort.featured')),
    option('updated', t('sort.updated')),
    option('name', t('sort.name')),
  ].join('')

  elements.kind.value = state.kind
  elements.install.value = state.install
  elements.channel.value = state.channel
  elements.sort.value = state.sort
}

function showToast(message) {
  elements.toast.textContent = message
  elements.toast.classList.add('is-visible')
  window.clearTimeout(showToast.timeout)
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 1900)
}

async function copyText(text, messageKey = 'dialog.copied') {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  showToast(t(messageKey))
}

function releaseCard(project, pkg, item) {
  const version = item?.version ? `v${item.version}` : item.ref.slice(0, 7)
  const current = item.id === project.latestRelease
  const capabilities = [
    item.capabilities?.requiresFabric ? t('project.requiresFabric') : '',
    item.capabilities?.deepHook ? t('project.deepHook') : '',
    item.capabilities?.restartRequired ? t('project.restartRequired') : '',
  ].filter(Boolean)
  return `
    <article class="release-card ${current ? 'is-current' : ''}">
      <div class="release-card-top">
        <span>${escapeHtml(current ? t('project.mainRelease') : t('project.previousRelease'))}</span>
        <span>${escapeHtml(factValue(item.channel || 'stable'))} · ${escapeHtml(factValue(item.state || 'active'))}</span>
      </div>
      <strong>${escapeHtml(version)}</strong>
      <code>${escapeHtml(item.ref)}</code>
      <dl>
        <div><dt>${escapeHtml(t('project.updated'))}</dt><dd>${escapeHtml(formatDate(item.updatedAt, 'long'))}</dd></div>
        <div><dt>${escapeHtml(t('project.runtimeFormat'))}</dt><dd>${escapeHtml(kindLabel(item.runtime?.kind || pkg.kind))}</dd></div>
        <div><dt>${escapeHtml(t('project.installMethod'))}</dt><dd>${escapeHtml(installMethodLabel(pkg))}</dd></div>
      </dl>
      ${item.changelog ? `<p class="release-changelog"><strong>${escapeHtml(t('project.changelog'))}</strong><span>${escapeHtml(item.changelog)}</span></p>` : ''}
      ${item.notice ? `<p class="release-notice">${escapeHtml(item.notice)}</p>` : ''}
      ${capabilities.length > 0 ? `<div class="release-capabilities">${capabilities.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div>` : ''}
      <a href="${escapeHtml(`${pkg.repository}/tree/${item.ref}${pkg.repositoryPath || ''}`)}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
    </article>`
}

function openAuthor(url, updateHash = true) {
  const legacyAuthor = state.packages.find((pkg) => pkg.author.url === url)
  const requestedIdentity = legacyAuthor ? authorIdentity(legacyAuthor.author) : url
  const packages = state.packages
    .filter((pkg) => !isAnonymousAuthor(pkg.author) && authorIdentity(pkg.author) === requestedIdentity)
    .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt))
  if (packages.length === 0) return
  const author = packages.map((pkg) => pkg.author).find((candidate) => githubProfileUrl(candidate)) || packages[0].author
  const profileUrl = githubProfileUrl(author)
  elements.dialog.dataset.packageId = ''
  elements.dialog.dataset.collectionId = ''
  elements.dialog.dataset.authorUrl = requestedIdentity
  elements.dialog.dataset.returnAuthorUrl = ''
  elements.dialogContent.innerHTML = `
    <div class="dialog-body author-dialog">
      <div class="author-dialog-heading">
        ${authorMark({ author }, 'author-dialog-avatar')}
        <div>
          <span>${escapeHtml(t('authors.profileLabel'))}</span>
          <h2 id="dialog-title">${escapeHtml(authorDisplayName(author))}</h2>
          <p>${escapeHtml(formatText(packages.length === 1 ? 'authors.portfolioDescriptionOne' : 'authors.portfolioDescription', { name: authorDisplayName(author), count: packages.length }))}</p>
        </div>
      </div>
      <div class="author-project-list">
        ${packages.map((pkg) => {
          const copy = packageText(pkg)
          const version = pkg.version ? `v${pkg.version}` : pkg.ref.slice(0, 7)
          const visual = projectVisual(pkg, 'icon')
          return `
            <button class="author-project" type="button" data-open-package="${escapeHtml(pkg.id)}">
              <span class="author-project-mark project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" data-media-state="${visual.state}" data-visual-format="icon" aria-hidden="true">${visual.content}</span>
              <span>
                <strong>${escapeHtml(copy.name)}</strong>
                <small>${escapeHtml(kindLabel(pkg.kind))} · ${escapeHtml(version)} · ${escapeHtml(catalogAccessLabel(pkg))}</small>
              </span>
              <span>${escapeHtml(t('row.details'))}</span>
            </button>`
        }).join('')}
      </div>
      <div class="dialog-actions">
        ${profileUrl ? `<a class="secondary-action" href="${escapeHtml(profileUrl)}">${escapeHtml(t('authors.viewGitHub'))} ↗</a>` : ''}
      </div>
    </div>`
  if (!elements.dialog.open) elements.dialog.showModal()
  if (updateHash) pushOverlayRoute('author', requestedIdentity)
}

function openCollection(id, updateHash = true) {
  const collection = state.collections.find((candidate) => candidate.id === id)
  if (!collection) return
  const copy = collectionText(collection)
  const items = collection.items.map((item) => ({ ...item, project: state.projects.get(item.projectId) })).filter((item) => item.project)
  elements.dialog.dataset.packageId = ''
  elements.dialog.dataset.collectionId = id
  elements.dialog.dataset.authorUrl = ''
  elements.dialog.dataset.returnAuthorUrl = ''
  elements.dialogContent.innerHTML = `
    <div class="dialog-body collection-dialog">
      <div class="dialog-meta"><span>${escapeHtml(t('collections.label'))}</span><span>${escapeHtml(t('collections.atomic'))}</span></div>
      <h2 id="dialog-title">${escapeHtml(copy.title)}</h2>
      <code class="dialog-id">${escapeHtml(collection.id)}</code>
      <p class="dialog-description">${escapeHtml(copy.summary)}</p>
      <section class="management-boundary boundary-transactional">
        <span class="management-boundary-label">${escapeHtml(t('management.transactional'))}</span>
        <div><strong>${escapeHtml(t('collections.singleCandidateTitle'))}</strong><p>${escapeHtml(t('collections.singleCandidateDescription'))}</p></div>
      </section>
      <div class="collection-dialog-list">
        ${items.map((item) => `
          <button type="button" data-open-package="${escapeHtml(item.projectId)}">
            <span><strong>${escapeHtml(item.project.displayName)}</strong><code>${escapeHtml(item.releaseId)}</code></span>
            <span>${escapeHtml(t('row.details'))}</span>
          </button>`).join('')}
      </div>
      <div class="dialog-actions">
        <button class="primary-action copy-collection-id" type="button">${escapeHtml(t('collections.copyId'))}</button>
        <a class="secondary-action" href="install.html">${escapeHtml(t('collections.harnessGuide'))}</a>
      </div>
      <p class="dialog-safety">${escapeHtml(t('collections.publicBoundary'))}</p>
    </div>`
  elements.dialogContent.querySelector('.copy-collection-id').addEventListener('click', () => {
    void copyText(collection.id, 'collections.idCopied')
  })
  if (!elements.dialog.open) elements.dialog.showModal()
  if (updateHash) pushOverlayRoute('collection', collection.id)
}

function ecosystemInsight(release, runRecords, collections) {
  const relations = release?.relations || { state: 'not-declared', required: [], optional: [] }
  const hasReproduction = runRecords.some((record) => record.reproduces !== null)
  let suggestion = 'project.suggestion.ready'
  if (relations.state !== 'declared') suggestion = 'project.suggestion.declareRelations'
  else if (runRecords.length === 0) suggestion = 'project.suggestion.addRunRecord'
  else if (!hasReproduction) suggestion = 'project.suggestion.reproduceRun'
  else if (release?.management?.recoveryScope === 'none') suggestion = 'project.suggestion.documentRecovery'
  else if (release?.capabilities?.restartRequired === true) suggestion = 'project.suggestion.documentRestart'
  else if (collections.length === 0) suggestion = 'project.suggestion.publishCollection'

  return {
    relations,
    hasReproduction,
    dependency: relations.state === 'declared'
      ? formatText('project.dependenciesDeclared', { required: relations.required.length, optional: relations.optional.length })
      : t('project.dependenciesUnknown'),
    compatibility: runRecords.length > 0
      ? formatText('project.compatibilityObserved', { count: runRecords.length })
      : t('project.compatibilityDeclaredOnly'),
    compatibilityDetail: hasReproduction ? t('project.compatibilityReproduced') : t('project.compatibilityEvidenceBoundary'),
    composition: collections.length > 0
      ? formatText('project.compositionCount', { count: collections.length })
      : t('project.noCompositions'),
    suggestion: t(suggestion),
  }
}

function relationRows(items) {
  return items.map((relation) => {
    const project = state.projects.get(relation.projectId)
    return `<button type="button" data-open-package="${escapeHtml(relation.projectId)}">
      <span><strong>${escapeHtml(project?.displayName || relation.projectId)}</strong><code>${escapeHtml(relation.releaseId)}</code></span>
      <span>${escapeHtml(t('row.details'))}</span>
    </button>`
  }).join('')
}

function openMarketProject(pkg, updateHash = true, requestedTab = 'overview') {
  const copy = packageText(pkg)
  const layer = projectMarketLayer(pkg)
  const detailVisual = projectVisual(pkg, 'cover', { decorative: false })
  const returnAuthorUrl = elements.dialog.dataset.authorUrl || elements.dialog.dataset.returnAuthorUrl || ''
  const discussions = (state.community.discussions || []).filter((item) => item.projectId === pkg.id)
  const activeTab = ['overview', 'discussions'].includes(requestedTab) ? requestedTab : 'overview'
  elements.dialog.dataset.packageId = pkg.id
  elements.dialog.dataset.collectionId = ''
  elements.dialog.dataset.authorUrl = ''
  elements.dialog.dataset.returnAuthorUrl = returnAuthorUrl
  elements.dialogContent.innerHTML = `
    <div class="dialog-body market-project-dialog">
      ${returnAuthorUrl ? `<button class="project-back" type="button" data-back-author>${escapeHtml(t('authors.backToProjects'))}</button>` : ''}
      <div class="project-detail-visual project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" data-media-state="${detailVisual.state}" data-visual-format="cover">
        ${detailVisual.content}
      </div>
      <div class="dialog-meta">
        <span>${escapeHtml(marketLayerLabel(layer))}</span>
        <span>${escapeHtml(kindLabel(pkg.kind))}</span>
        <span>${escapeHtml(statusLabel(pkg.status))}</span>
      </div>
      <h2 id="dialog-title">${escapeHtml(copy.name)}</h2>
      <code class="dialog-id">${escapeHtml(pkg.id)}</code>
      <nav class="project-tabs" aria-label="${escapeHtml(t('project.tabsLabel'))}" role="tablist">
        ${['overview', 'discussions'].map((tab) => `
          <button type="button" role="tab" data-project-tab="${tab}" aria-selected="${activeTab === tab}">${escapeHtml(t(`project.tab.${tab}`))}</button>
        `).join('')}
      </nav>
      <section class="project-panel" role="tabpanel" data-project-panel="overview">
        <p class="dialog-description">${escapeHtml(copy.description)}</p>
        <dl class="dialog-facts">
          <div><dt>${escapeHtml(t('dialog.author'))}</dt><dd>${authorLink(pkg.author)}</dd></div>
          <div><dt>${escapeHtml(t('dialog.version'))}</dt><dd>${escapeHtml(pkg.version ? `v${pkg.version}` : pkg.ref.slice(0, 7))}</dd></div>
          <div><dt>${escapeHtml(t('dialog.license'))}</dt><dd>${escapeHtml(pkg.license)}</dd></div>
          <div><dt>${escapeHtml(t('project.updated'))}</dt><dd>${escapeHtml(formatDate(pkg.updatedAt, 'long'))}</dd></div>
        </dl>
        <section class="management-boundary boundary-informational">
          <span class="management-boundary-label">${escapeHtml(marketLayerLabel(layer))}</span>
          <div>
            <strong>${escapeHtml(t(`market.boundary.${layer}.title`))}</strong>
            <p>${escapeHtml(t(`market.boundary.${layer}.description`))}</p>
          </div>
        </section>
        <section class="install-panel market-source-panel">
          <div class="install-heading">
            <h3>${escapeHtml(t('market.sourceTitle'))}</h3>
            <span>${escapeHtml(t('market.informationalOnly'))}</span>
          </div>
          <p class="install-note">${escapeHtml(t('market.sourceNote'))}</p>
          <a class="primary-action" href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('market.viewSource'))} ↗</a>
        </section>
        <p class="dialog-safety">${escapeHtml(t('market.safety'))}</p>
        <div class="dialog-source">
          <div>
            <strong>${escapeHtml(t(pkg.marketData?.verification?.state === 'unverified' ? 'market.sourceTitle' : 'dialog.fixedSource'))}</strong>
            <code>${escapeHtml(pkg.ref)}</code>
          </div>
          <a href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
        </div>
      </section>
      <section class="project-panel" role="tabpanel" data-project-panel="discussions" hidden>
        <div class="project-panel-heading">
          <div><span>${escapeHtml(t('project.discussions'))}</span><strong>${escapeHtml(discussions.length)}</strong></div>
          <p>${escapeHtml(t('project.discussionsBoundary'))}</p>
        </div>
        <div class="project-discussions">
          ${discussions.map(discussionRow).join('') || `<div class="community-empty"><strong>${escapeHtml(t('project.noDiscussionsTitle'))}</strong><p>${escapeHtml(t('project.noDiscussionsDescription'))}</p></div>`}
        </div>
        <a class="secondary-action discussion-external" href="${escapeHtml(`${pkg.repository}/discussions`)}">${escapeHtml(t('project.openDiscussions'))} ↗</a>
      </section>
    </div>`
  elements.dialogContent.querySelector('[data-back-author]')?.addEventListener('click', (event) => {
    event.preventDefault()
    returnToAuthor()
  })
  activateProjectTab(activeTab)
  if (!elements.dialog.open) elements.dialog.showModal()
  if (updateHash) pushOverlayRoute('package', pkg.id)
}

function openPackage(id, updateHash = true, requestedTab = 'overview') {
  const pkg = state.packages.find((candidate) => candidate.id === id) || state.catalogComponents.get(id)
  if (!pkg) return
  if (projectMarketLayer(pkg) !== 'plugin') {
    openMarketProject(pkg, updateHash, requestedTab)
    return
  }
  const copy = packageText(pkg)
  const { project, release } = projectRelease(pkg)
  const version = release?.version ? `v${release.version}` : pkg.ref.slice(0, 7)
  const boundary = managementBoundary(pkg.install.type)
  const access = packageAccessState(pkg)
  const guided = access === 'guided-verified'
  const verifiedPending = access === 'verified-pending'
  const sourceOnly = access === 'source-only'
  const installBlocked = access === 'blocked'
  const detailVisual = projectVisual(pkg, 'cover', { decorative: false })
  const media = projectMedia(pkg)
  const evidenceProjectIds = new Set(pkg.presentationGroup?.componentIds || [pkg.id])
  const runRecords = state.runRecords.filter((record) => evidenceProjectIds.has(record.projectId)
    && (pkg.presentationGroup || record.releaseId === release?.id))
  const hasReproduction = runRecords.some((record) => record.reproduces !== null)
  const releaseCollections = state.collections.filter((collection) => collection.items.some((item) => evidenceProjectIds.has(item.projectId)
    && (pkg.presentationGroup || item.releaseId === release?.id)))
  const insight = ecosystemInsight(release, runRecords, releaseCollections)
  const returnAuthorUrl = elements.dialog.dataset.authorUrl || elements.dialog.dataset.returnAuthorUrl || ''
  elements.dialog.dataset.packageId = id
  elements.dialog.dataset.collectionId = ''
  elements.dialog.dataset.authorUrl = ''
  elements.dialog.dataset.returnAuthorUrl = returnAuthorUrl
  elements.dialogContent.innerHTML = `
    <div class="dialog-body">
      ${returnAuthorUrl ? `<button class="project-back" type="button" data-back-author>${escapeHtml(t('authors.backToProjects'))}</button>` : ''}
      <div class="project-detail-visual project-visual mark-${escapeHtml(pkg.category || 'uncategorized')}" data-media-state="${detailVisual.state}" data-visual-format="cover">
        ${detailVisual.content}
      </div>
      <div class="dialog-meta">
        <span>${escapeHtml(kindLabel(pkg.kind))}</span>
        ${pkg.category ? `<span>${escapeHtml(categoryLabel(pkg.category))}</span>` : ''}
        <span>${escapeHtml(statusLabel(pkg.status))}</span>
        <span>${escapeHtml(catalogAccessLabel(pkg))}</span>
      </div>
      <h2 id="dialog-title">${escapeHtml(copy.name)}</h2>
      <code class="dialog-id">${escapeHtml(pkg.id)}</code>
      <nav class="project-tabs" aria-label="${escapeHtml(t('project.tabsLabel'))}" role="tablist">
        ${['overview', 'releases', 'compatibility', 'relations', 'discussions'].map((tab) => `
          <button type="button" role="tab" data-project-tab="${tab}" aria-selected="${requestedTab === tab}">${escapeHtml(t(`project.tab.${tab}`))}</button>
        `).join('')}
      </nav>
      <section class="project-panel" role="tabpanel" data-project-panel="overview">
        <p class="dialog-description">${escapeHtml(copy.description)}</p>
        ${presentationGroupSection(pkg)}
        ${media?.screenshots?.length > 0 ? `<div class="project-gallery">${media.screenshots.map((asset, index) => `<img src="${escapeHtml(asset.url)}" alt="${escapeHtml(`${copy.name} ${t('project.screenshot')} ${index + 1}`)}" loading="lazy" decoding="async" data-project-media>`).join('')}</div>` : ''}
        ${project?.lifecycle?.state && project.lifecycle.state !== 'active' ? `<section class="project-lifecycle"><strong>${escapeHtml(factValue(project.lifecycle.state))}</strong><p>${escapeHtml(project.lifecycle.notice || t('project.lifecycleNotice'))}</p>${project.lifecycle.successor ? `<button type="button" data-open-package="${escapeHtml(project.lifecycle.successor)}">${escapeHtml(t('project.openSuccessor'))}</button>` : ''}</section>` : ''}
        <dl class="dialog-facts">
          <div><dt>${escapeHtml(t('dialog.author'))}</dt><dd>${authorLink(pkg.author)}</dd></div>
          <div><dt>${escapeHtml(t('dialog.version'))}</dt><dd>${escapeHtml(version)}</dd></div>
          <div><dt>${escapeHtml(t('dialog.license'))}</dt><dd>${escapeHtml(release?.license || pkg.license)}</dd></div>
          ${pkg.discovery?.createdAt ? `<div><dt>${escapeHtml(t('project.created'))}</dt><dd>${escapeHtml(formatDate(pkg.discovery.createdAt, 'long'))}</dd></div>` : ''}
          <div><dt>${escapeHtml(t('project.updated'))}</dt><dd>${escapeHtml(formatDate(release?.updatedAt || pkg.updatedAt, 'long'))}</dd></div>
        </dl>
        ${pkg.presentationGroup ? '' : capabilityMatrix(pkg)}
        <section class="management-boundary boundary-${escapeHtml(boundary.group)}">
          <span class="management-boundary-label">${escapeHtml(managementLabel(pkg.install.type))}</span>
          <div>
            <strong>${escapeHtml(boundary.title)}</strong>
            <p>${escapeHtml(boundary.description)}</p>
          </div>
        </section>
        ${installBlocked ? `<section class="install-panel install-unavailable"><div class="install-heading"><h3>${escapeHtml(t('project.installUnavailable'))}</h3><span>${escapeHtml(t('access.blocked'))}</span></div><p>${escapeHtml(pkg.install.note || release?.notice || t('project.installUnavailableDescription'))}</p></section>` : verifiedPending ? `<section class="install-panel install-unavailable">
          <div class="install-heading"><h3>${escapeHtml(t('install.awaitingApproval'))}</h3><span>${escapeHtml(t('access.verifiedPending'))}</span></div>
          <p>${escapeHtml(pkg.install.note || t('install.awaitingApprovalNote'))}</p>
          <a class="secondary-action" href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
        </section>` : guided ? `<section class="install-panel">
          <div class="install-heading">
            <h3>${escapeHtml(t('install.viewVerifiedGuide'))}</h3>
            <span>${escapeHtml(integrationRequirement(pkg))}</span>
          </div>
          <p class="install-note">${escapeHtml(pkg.install.note || omdshInstallNote(pkg))}</p>
          <a class="primary-action" href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('row.source'))} ↗</a>
        </section>` : sourceOnly ? `<section class="install-panel">
          <div class="install-heading"><h3>${escapeHtml(t('install.viewSourceOnly'))}</h3><span>${escapeHtml(t('access.sourceOnly'))}</span></div>
          <p class="install-note">${escapeHtml(pkg.install.note || t('install.note.guided'))}</p>
          <a class="primary-action" href="${escapeHtml(detailUrl(pkg))}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
        </section>` : `<section class="install-panel">
          <div class="install-heading">
            <h3>${escapeHtml(omdshActionLabel(pkg))}</h3>
            <span>${escapeHtml(managementLabel(pkg.install.type))} · ${escapeHtml(integrationRequirement(pkg))}</span>
          </div>
          <div class="code-block">
            <pre><code>${escapeHtml(omdshCommand(pkg))}</code></pre>
            <button class="copy-command" type="button">${escapeHtml(t('dialog.copy'))}</button>
          </div>
          <p class="install-note">${escapeHtml(omdshInstallNote(pkg))}</p>
          <details class="advanced-install">
            <summary>${escapeHtml(t('install.advanced'))}</summary>
            <dl>
              <div><dt>${escapeHtml(t('install.backend'))}</dt><dd>${escapeHtml(installBackend(pkg))}</dd></div>
              <div><dt>${escapeHtml(t('install.requirement'))}</dt><dd>${escapeHtml(integrationRequirement(pkg))}</dd></div>
            </dl>
            ${installGroup(pkg.install.type) !== 'guided' && copy.installNote ? `<p>${escapeHtml(copy.installNote)}</p>` : ''}
          </details>
        </section>`}
        <p class="dialog-safety">${escapeHtml(t('safety.short'))}</p>
        <div class="dialog-source">
          <div>
            <strong>${escapeHtml(t(release?.risk?.facts?.sourcePinned === true ? 'dialog.fixedSource' : 'market.sourceTitle'))}</strong>
            <code>${escapeHtml(release?.ref || pkg.ref)}</code>
          </div>
          <a href="${escapeHtml(project?.links?.repository || detailUrl(pkg))}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
        </div>
      </section>

      <section class="project-panel" role="tabpanel" data-project-panel="releases" hidden>
        <div class="project-panel-heading">
          <div><span>${escapeHtml(t('project.releaseCount'))}</span><strong>${escapeHtml(project?.releases?.length || 1)}</strong></div>
          <p>${escapeHtml(t('project.releaseHistoryBoundary'))}</p>
        </div>
        <div class="release-list">
          ${(project?.releases || [release]).filter(Boolean).map((item) => releaseCard(project || { latestRelease: release?.id }, pkg, item)).join('')}
        </div>
      </section>

      <section class="project-panel" role="tabpanel" data-project-panel="compatibility" hidden>
        <section class="ecosystem-insights">
          <div class="ecosystem-insights-heading">
            <h3>${escapeHtml(t('project.insightsTitle'))}</h3>
            <p>${escapeHtml(t('project.insightsDescription'))}</p>
          </div>
          <div class="ecosystem-insight-grid">
            <article><span>${escapeHtml(t('project.insightDependencies'))}</span><strong>${escapeHtml(insight.dependency)}</strong><small>${escapeHtml(t('project.insightDependenciesBoundary'))}</small></article>
            <article><span>${escapeHtml(t('project.insightCompatibility'))}</span><strong>${escapeHtml(insight.compatibility)}</strong><small>${escapeHtml(insight.compatibilityDetail)}</small></article>
            <article><span>${escapeHtml(t('project.insightSuggestion'))}</span><strong>${escapeHtml(insight.suggestion)}</strong><small>${escapeHtml(t('project.insightSuggestionBoundary'))}</small></article>
            <article><span>${escapeHtml(t('project.insightCompositions'))}</span><strong>${escapeHtml(insight.composition)}</strong><small>${escapeHtml(t('project.insightCompositionsBoundary'))}</small></article>
          </div>
          ${releaseCollections.length > 0 ? `<div class="ecosystem-compositions">${releaseCollections.map((collection) => `<button type="button" data-open-collection="${escapeHtml(collection.id)}">${escapeHtml(collectionText(collection).title)}</button>`).join('')}</div>` : ''}
        </section>
        <div class="project-info-block">
          <span>${escapeHtml(t('project.declaredCompatibility'))}</span>
          <strong>${escapeHtml(copy.compatibility)}</strong>
        </div>
        <section class="run-evidence${runRecords.length === 0 ? ' is-empty' : ''}">
          <div class="run-evidence-heading">
            <div>
              <span>${escapeHtml(t('project.runRecords'))}</span>
              <strong>${escapeHtml(runRecords.length === 0 ? t('project.noRunRecordsTitle') : formatText('project.runRecordCount', { count: runRecords.length }))}</strong>
            </div>
            ${hasReproduction ? `<span class="run-reproduced">${escapeHtml(t('project.reproduced'))}</span>` : ''}
          </div>
          <p>${escapeHtml(runRecords.length === 0 ? t('project.noRunRecordsDescription') : t('project.runRecordsDescription'))}</p>
          ${runRecords.length > 0 ? `<div class="run-record-list">${runRecords.map(runRecordRow).join('')}</div>` : ''}
        </section>
        <dl class="compatibility-facts">
          <div><dt>${escapeHtml(t('project.runtimeFormat'))}</dt><dd>${escapeHtml(kindLabel(release?.runtime?.kind || pkg.kind))}</dd></div>
          <div><dt>${escapeHtml(t('project.installMethod'))}</dt><dd>${escapeHtml(installMethodLabel(pkg))}</dd></div>
          <div><dt>${escapeHtml(t('project.managementCapability'))}</dt><dd>${escapeHtml(managementLabel(pkg.install.type))}</dd></div>
          <div><dt>${escapeHtml(t('project.recoveryScope'))}</dt><dd>${escapeHtml(factValue(release?.management?.recoveryScope || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.requiresFabric'))}</dt><dd>${escapeHtml(factValue(release?.capabilities?.requiresFabric === true))}</dd></div>
          <div><dt>${escapeHtml(t('project.deepHook'))}</dt><dd>${escapeHtml(factValue(release?.capabilities?.deepHook === true))}</dd></div>
          <div><dt>${escapeHtml(t('project.restartRequired'))}</dt><dd>${escapeHtml(factValue(release?.capabilities?.restartRequired === true))}</dd></div>
        </dl>
        <h3 class="project-section-title">${escapeHtml(t('project.scanFacts'))}</h3>
        <dl class="scan-facts">
          <div><dt>${escapeHtml(t('project.riskLevel'))}</dt><dd>${escapeHtml(factValue(release?.risk?.level || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.listingState'))}</dt><dd>${escapeHtml(factValue(release?.listing?.state || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.sourcePinned'))}</dt><dd>${escapeHtml(factValue(release?.risk?.facts?.sourcePinned === true))}</dd></div>
          <div><dt>${escapeHtml(t('project.vulnerabilityScan'))}</dt><dd>${escapeHtml(factValue(release?.risk?.facts?.vulnerabilityScan || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.permissions'))}</dt><dd>${escapeHtml(factValue(release?.risk?.facts?.permissions || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.nativeCode'))}</dt><dd>${escapeHtml(factValue(release?.risk?.facts?.nativeCode || 'unknown'))}</dd></div>
          <div><dt>${escapeHtml(t('project.installScripts'))}</dt><dd>${escapeHtml(factValue(release?.risk?.facts?.installScripts || 'unknown'))}</dd></div>
        </dl>
      </section>

      <section class="project-panel" role="tabpanel" data-project-panel="relations" hidden>
        ${insight.relations.state !== 'declared' ? `<div class="relations-empty">
          <span aria-hidden="true">↔</span>
          <div><strong>${escapeHtml(t('project.noRelationsTitle'))}</strong><p>${escapeHtml(t('project.noRelationsDescription'))}</p></div>
        </div>` : `<div class="relations-declared">
          <strong>${escapeHtml(t('project.declaredRelationsTitle'))}</strong>
          <p>${escapeHtml(t('project.declaredRelationsDescription'))}</p>
        </div>
        <h3 class="project-section-title">${escapeHtml(t('project.requiredDependencies'))}</h3>
        <div class="relation-list">${relationRows(insight.relations.required) || `<p>${escapeHtml(t('project.noRequiredDependencies'))}</p>`}</div>
        <h3 class="project-section-title">${escapeHtml(t('project.optionalDependencies'))}</h3>
        <div class="relation-list">${relationRows(insight.relations.optional) || `<p>${escapeHtml(t('project.noOptionalDependencies'))}</p>`}</div>`}
        <dl class="compatibility-facts relation-facts">
          <div><dt>${escapeHtml(t('project.requiredDependencies'))}</dt><dd>${escapeHtml(insight.relations.state === 'declared' ? insight.relations.required.length : factValue('not-declared'))}</dd></div>
          <div><dt>${escapeHtml(t('project.optionalDependencies'))}</dt><dd>${escapeHtml(insight.relations.state === 'declared' ? insight.relations.optional.length : factValue('not-declared'))}</dd></div>
        </dl>
      </section>

      <section class="project-panel" role="tabpanel" data-project-panel="discussions" hidden>
        <div class="project-panel-heading">
          <div><span>${escapeHtml(t('project.discussions'))}</span><strong>${escapeHtml((state.community.discussions || []).filter((item) => evidenceProjectIds.has(item.projectId)).length)}</strong></div>
          <p>${escapeHtml(t('project.discussionsBoundary'))}</p>
        </div>
        <div class="project-discussions">
          ${(state.community.discussions || []).filter((item) => evidenceProjectIds.has(item.projectId)).map(discussionRow).join('') || `<div class="community-empty"><strong>${escapeHtml(t('project.noDiscussionsTitle'))}</strong><p>${escapeHtml(t('project.noDiscussionsDescription'))}</p></div>`}
        </div>
        <a class="secondary-action discussion-external" href="${escapeHtml(project?.links?.discussions || `${pkg.repository}/discussions`)}">${escapeHtml(t('project.openDiscussions'))} ↗</a>
      </section>
    </div>`
  elements.dialogContent.querySelector('.copy-command')?.addEventListener('click', () => copyText(omdshCommand(pkg)))
  elements.dialogContent.querySelector('[data-back-author]')?.addEventListener('click', (event) => {
    event.preventDefault()
    returnToAuthor()
  })
  activateProjectTab(requestedTab)
  if (!elements.dialog.open) elements.dialog.showModal()
  if (updateHash) {
    const currentRoute = new URLSearchParams(location.hash.slice(1))
    if (returnAuthorUrl && history.state?.workshopOverlay && currentRoute.has('author')) {
      replaceOverlayRoute('package', pkg.id)
    } else {
      pushOverlayRoute('package', pkg.id)
    }
  }
}

function openCandidate(id, updateHash = true) {
  const pkg = state.candidates.find((candidate) => candidate.id === id)
  if (!pkg) return
  const candidate = pkg.candidateData
  const declarations = candidate.declaration.types
  const adapter = candidate.install.possibleAdapter
  const source = detailUrl(pkg)
  elements.dialog.dataset.packageId = ''
  elements.dialog.dataset.candidateId = id
  elements.dialog.dataset.collectionId = ''
  elements.dialog.dataset.authorUrl = ''
  elements.dialog.dataset.returnAuthorUrl = ''
  elements.dialogContent.innerHTML = `
    <div class="dialog-body candidate-dialog">
      <div class="dialog-meta">
        <span>${escapeHtml(t('candidates.pending'))}</span>
        <span>${escapeHtml(kindLabel(pkg.kind))}</span>
        <span>${escapeHtml(presentationLabel(candidate.presentation))}</span>
      </div>
      <h2 id="dialog-title">${escapeHtml(pkg.name)}</h2>
      <code class="dialog-id">${escapeHtml(pkg.repository.replace('https://github.com/', ''))}${escapeHtml(pkg.repositoryPath || '')}</code>
      <p class="dialog-description">${escapeHtml(pkg.description)}</p>
      <section class="candidate-gate">
        <span aria-hidden="true">⌁</span>
        <div>
          <strong>${escapeHtml(t('candidates.notInstallable'))}</strong>
          <p>${escapeHtml(t('candidates.boundary'))}</p>
        </div>
      </section>
      <dl class="candidate-facts">
        <div><dt>${escapeHtml(t('candidates.scanDecision'))}</dt><dd>${escapeHtml(factValue(candidate.review.scanDecision))}</dd></div>
        <div><dt>${escapeHtml(t('project.riskLevel'))}</dt><dd>${escapeHtml(factValue(candidate.review.risk))}</dd></div>
        <div><dt>${escapeHtml(t('candidates.declarations'))}</dt><dd>${escapeHtml(declarations.length > 0 ? declarations.map(declarationLabel).join(' · ') : t('candidates.noManifest'))}</dd></div>
        <div><dt>${escapeHtml(t('candidates.possibleAdapter'))}</dt><dd>${escapeHtml(adapter === 'official-profile/v1' ? t('install.backend.officialProfile') : adapter === 'official-repository/v1' ? t('install.backend.officialRepository') : t('factValue.unknown'))}</dd></div>
        <div><dt>${escapeHtml(t('dialog.version'))}</dt><dd>${escapeHtml(candidate.declaration.version || t('factValue.unknown'))}</dd></div>
        <div><dt>${escapeHtml(t('project.updated'))}</dt><dd>${escapeHtml(formatDate(pkg.updatedAt, 'long'))}</dd></div>
      </dl>
      <div class="candidate-manifests">
        <strong>${escapeHtml(t('candidates.manifests'))}</strong>
        ${candidate.declaration.manifests.length > 0
          ? `<ul>${candidate.declaration.manifests.map((manifest) => `<li><code>${escapeHtml(manifest)}</code></li>`).join('')}</ul>`
          : `<p>${escapeHtml(t('candidates.noManifestDescription'))}</p>`}
      </div>
      <p class="candidate-review-note">${escapeHtml(t('candidates.reviewNote'))}</p>
      <div class="candidate-actions">
        <a class="primary-action" href="publish.html?candidate=${encodeURIComponent(candidate.id)}">${escapeHtml(t('candidates.apply'))}</a>
        <span>${escapeHtml(t('candidates.applyHelp'))}</span>
      </div>
      <div class="dialog-source">
        <div>
          <strong>${escapeHtml(t('dialog.fixedSource'))}</strong>
          <code>${escapeHtml(pkg.ref)}</code>
        </div>
        <a href="${escapeHtml(source)}">${escapeHtml(t('dialog.viewSource'))} ↗</a>
      </div>
    </div>`
  if (!elements.dialog.open) elements.dialog.showModal()
  if (updateHash) pushOverlayRoute('candidate', id)
}

function resetFilters() {
  state.query = ''
  state.category = 'all'
  state.kind = 'all'
  state.install = 'all'
  state.channel = 'all'
  state.scope = 'all'
  state.sort = 'featured'
  state.visible = 24
  elements.search.value = ''
  if (elements.advancedFilter) elements.advancedFilter.open = false
  renderFilters()
  render()
  alignResultsToTop()
}

function applyInstallView(mode) {
  state.install = mode
  state.visible = 24
  elements.install.value = mode
  render()
  alignResultsToTop()
}

function bindEvents() {
  document.addEventListener('error', (event) => {
    if (event.target instanceof HTMLImageElement && event.target.matches('[data-project-media]')) {
      const visual = event.target.closest('.project-visual')
      if (visual) visual.dataset.mediaState = 'generated'
      event.target.remove()
      return
    }
    if (event.target instanceof HTMLImageElement && event.target.matches('[data-avatar]')) {
      const fallback = document.createElement('span')
      fallback.className = event.target.className.replace(/\bauthor-avatar\b/, 'author-fallback')
      fallback.setAttribute('aria-hidden', 'true')
      fallback.textContent = event.target.dataset.avatarFallback || 'D'
      event.target.replaceWith(fallback)
    }
  }, true)
  elements.search.addEventListener('input', (event) => { state.query = event.target.value; state.visible = 24; render() })
  elements.featured.addEventListener('scroll', updateFeaturedRail, { passive: true })
  elements.featuredPrevious.addEventListener('click', () => scrollFeatured(-1))
  elements.featuredNext.addEventListener('click', () => scrollFeatured(1))
  elements.authorToggle.addEventListener('click', () => {
    state.authorsExpanded = !state.authorsExpanded
    renderAuthors()
  })
  window.addEventListener('resize', updateFeaturedRail)
  elements.filterPanel?.addEventListener('pointermove', (event) => {
    const bounds = elements.filterPanel.getBoundingClientRect()
    elements.filterPanel.style.setProperty('--glass-x', `${event.clientX - bounds.left}px`)
    elements.filterPanel.style.setProperty('--glass-y', `${event.clientY - bounds.top}px`)
  })
  elements.filterPanel?.addEventListener('pointerleave', () => {
    elements.filterPanel.style.removeProperty('--glass-x')
    elements.filterPanel.style.removeProperty('--glass-y')
  })
  elements.kind.addEventListener('change', (event) => {
    state.kind = event.target.value
    state.visible = 24
    render()
    alignResultsToTop()
  })
  elements.install.addEventListener('change', (event) => {
    applyInstallView(event.target.value)
  })
  elements.channel.addEventListener('change', (event) => {
    state.channel = event.target.value
    state.visible = 24
    render()
    alignResultsToTop()
  })
  elements.sort.addEventListener('change', (event) => { state.sort = event.target.value; state.visible = 24; render() })
  elements.categories.addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]')
    if (!button) return
    state.category = button.dataset.category
    state.visible = 24
    render()
    alignResultsToTop()
  })
  document.querySelectorAll('[data-market-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      state.marketLayer = button.dataset.marketLayer
      state.scope = 'all'
      state.category = 'all'
      state.kind = 'all'
      state.install = 'all'
      state.channel = 'all'
      state.visible = 24
      renderFilters()
      render()
      alignResultsToTop()
    })
  })
  // Keep modal navigation local to the top-layer dialog. Relying only on the
  // document delegate leaves author/project transitions inert in browsers
  // that isolate synthetic top-layer dialog events.
  elements.dialogContent.addEventListener('click', (event) => {
    const authorButton = event.target.closest('[data-open-author]')
    if (authorButton) {
      event.stopPropagation()
      openAuthor(authorButton.dataset.openAuthor)
      return
    }
    const packageButton = event.target.closest('[data-open-package]')
    if (packageButton) {
      event.stopPropagation()
      openPackage(packageButton.dataset.openPackage)
      return
    }
    const candidateButton = event.target.closest('[data-open-candidate]')
    if (candidateButton) {
      event.stopPropagation()
      openCandidate(candidateButton.dataset.openCandidate)
    }
  })
  document.addEventListener('click', (event) => {
    if (elements.advancedFilter?.open && !elements.advancedFilter.contains(event.target)) {
      elements.advancedFilter.open = false
    }
    const projectTab = event.target.closest('[data-project-tab]')
    if (projectTab && elements.dialog.contains(projectTab)) {
      activateProjectTab(projectTab.dataset.projectTab)
      return
    }
    const installView = event.target.closest('[data-install-view]')
    if (installView) {
      applyInstallView(installView.dataset.installView)
      return
    }
    const featuredMode = event.target.closest('[data-featured-mode]')
    if (featuredMode) {
      state.featuredMode = featuredMode.dataset.featuredMode
      renderFeatured()
      return
    }
    const catalogView = event.target.closest('[data-catalog-view]')
    if (catalogView) {
      state.view = catalogView.dataset.catalogView
      render()
      alignResultsToTop()
      return
    }
    const catalogScope = event.target.closest('[data-catalog-scope]')
    if (catalogScope) {
      state.scope = catalogScope.dataset.catalogScope
      state.visible = 24
      if (state.scope === 'candidates' && state.install !== 'all' && state.install !== 'pending') state.install = 'all'
      renderFilters()
      render()
      alignResultsToTop()
      return
    }
    const copyButton = event.target.closest('[data-copy-install]')
    if (copyButton) {
      const pkg = state.packages.find((candidate) => candidate.id === copyButton.dataset.copyInstall)
      if (pkg) copyText(omdshCommand(pkg))
      return
    }
    const subscribeButton = event.target.closest('[data-copy-subscribe]')
    if (subscribeButton) {
      void copyText(subscribeButton.dataset.copySubscribe, 'row.subscribeCopied')
      return
    }
    const collectionButton = event.target.closest('[data-open-collection]')
    if (collectionButton) {
      openCollection(collectionButton.dataset.openCollection)
      return
    }
    const authorButton = event.target.closest('[data-open-author]')
    if (authorButton) {
      openAuthor(authorButton.dataset.openAuthor)
      return
    }
    const candidateButton = event.target.closest('[data-open-candidate]')
    if (candidateButton) {
      openCandidate(candidateButton.dataset.openCandidate)
      return
    }
    const button = event.target.closest('[data-open-package]')
    if (button) openPackage(button.dataset.openPackage)
  })
  document.querySelector('#reset-filters').addEventListener('click', resetFilters)
  document.querySelector('#reset-filters-top').addEventListener('click', resetFilters)
  elements.loadMore.addEventListener('click', () => {
    state.visible += 24
    render()
  })
  document.querySelector('.dialog-close').addEventListener('click', closeOverlay)
  elements.dialog.addEventListener('click', (event) => {
    if (event.target === elements.dialog) closeOverlay()
  })
  elements.dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeOverlay()
  })
  elements.dialog.addEventListener('close', () => {
    elements.dialog.dataset.packageId = ''
    elements.dialog.dataset.candidateId = ''
    elements.dialog.dataset.collectionId = ''
    elements.dialog.dataset.authorUrl = ''
    elements.dialog.dataset.returnAuthorUrl = ''
  })
  window.addEventListener('popstate', syncOverlayRoute)
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      event.preventDefault()
      elements.search.focus()
    }
  })
  document.addEventListener('dsh:locale', () => {
    renderFilters()
    renderWorkshopModes()
    renderSpotlight()
    renderFeatured()
    renderCollections()
    renderCommunity()
    renderAuthors()
    render()
    document.querySelector('#snapshot-time').textContent = formatDate(state.snapshot, 'long')
    if (elements.dialog.open && elements.dialog.dataset.packageId) {
      openPackage(elements.dialog.dataset.packageId, false, elements.dialog.dataset.projectTab || 'overview')
    } else if (elements.dialog.open && elements.dialog.dataset.candidateId) {
      openCandidate(elements.dialog.dataset.candidateId, false)
    } else if (elements.dialog.open && elements.dialog.dataset.collectionId) {
      openCollection(elements.dialog.dataset.collectionId, false)
    } else if (elements.dialog.open && elements.dialog.dataset.authorUrl) {
      openAuthor(elements.dialog.dataset.authorUrl, false)
    }
  })
}

async function init() {
  bindEvents()
  bindSectionNavigation()
  try {
    const [response, workshopResponse, candidateResponse, marketResponse] = await Promise.all([
      fetch('catalog.json'),
      fetch('workshop-v1.json'),
      fetch('candidates-v1.json'),
      fetch('market-layers.json'),
      window.dshI18nReady,
    ])
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!workshopResponse.ok) throw new Error(`Workshop HTTP ${workshopResponse.status}`)
    if (!candidateResponse.ok) throw new Error(`Candidates HTTP ${candidateResponse.status}`)
    if (!marketResponse.ok) throw new Error(`Market HTTP ${marketResponse.status}`)
    const index = await response.json()
    const workshop = await workshopResponse.json()
    const candidateFeed = await candidateResponse.json()
    const marketFeed = await marketResponse.json()
    const presentation = catalogPresentation(index)
    state.catalogComponents = new Map(presentation.components.map((pkg) => [pkg.id, { ...pkg, marketLayer: 'plugin' }]))
    state.packages = [
      ...presentation.listings.map((pkg) => ({ ...pkg, marketLayer: 'plugin' })),
      ...(marketFeed.projects || []).map(marketProject),
    ]
    state.candidates = (candidateFeed.projects || []).map(candidatePackage)
    state.projects = new Map((workshop.projects || []).map((project) => [project.id, project]))
    state.runRecords = workshop.runRecords || []
    state.collections = workshop.collections || []
    state.community = workshop.community || { sources: [], discussions: [] }
    state.snapshot = index.updated
    document.querySelector('#stat-packages').textContent = state.packages.length
    document.querySelector('#stat-repositories').textContent = new Set(state.packages.map((pkg) => pkg.repository)).size
    document.querySelector('#stat-categories').textContent = new Set(state.packages.map((pkg) => pkg.category).filter(Boolean)).size
    document.querySelector('#snapshot-time').textContent = formatDate(index.updated, 'long')
    renderFilters()
    renderWorkshopModes()
    renderSpotlight()
    renderFeatured()
    renderCollections()
    renderCommunity()
    renderAuthors()
    render()
    syncOverlayRoute()
  } catch (error) {
    elements.list.setAttribute('aria-busy', 'false')
    elements.list.innerHTML = `<p class="load-error">${escapeHtml(t('error.load'))} ${escapeHtml(String(error))}</p>`
  }
}

init()
