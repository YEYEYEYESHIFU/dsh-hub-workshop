(() => {
  const modeButtons = [...document.querySelectorAll('[data-publish-mode]')]
  const modePanels = [...document.querySelectorAll('[data-publish-panel]')]
  const packModeButtons = [...document.querySelectorAll('[data-pack-mode]')]
  const form = document.querySelector('#distribution-form')
  if (!form) return

  const picker = document.querySelector('#distribution-release-picker')
  const addButton = document.querySelector('#distribution-add-release')
  const addOwnButton = document.querySelector('#distribution-add-own')
  const itemList = document.querySelector('#distribution-items')
  const empty = document.querySelector('#distribution-items-empty')
  const licenseList = document.querySelector('#pack-license-list')
  const licenseEmpty = document.querySelector('#pack-license-empty')
  const trustLabel = document.querySelector('#pack-trust-label')
  const publicationFields = document.querySelector('#distribution-publication-fields')
  const error = document.querySelector('#distribution-error')
  const output = document.querySelector('#distribution-output')
  const preview = document.querySelector('#distribution-preview')
  const previewMode = document.querySelector('#pack-preview-mode')
  const copyButton = document.querySelector('#copy-distribution')
  const downloadButton = document.querySelector('#download-distribution')
  const copyCliButton = document.querySelector('#copy-distribution-cli')
  const cliCommand = document.querySelector('#distribution-cli-command')
  const submission = document.querySelector('#open-distribution-submission')
  const selected = new Map()
  let releases = []
  let manifest = null
  let packMode = 'local'

  const t = (key) => window.DSHHub?.t(key) || key
  const escapeHtml = (value) => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

  function setPublishPanel(name, updateUrl = true) {
    if (!['project', 'distribution'].includes(name)) name = 'project'
    for (const button of modeButtons) {
      const active = button.dataset.publishMode === name
      button.setAttribute('aria-selected', String(active))
      button.tabIndex = active ? 0 : -1
    }
    for (const panel of modePanels) panel.hidden = panel.dataset.publishPanel !== name
    if (updateUrl) {
      const url = new URL(location.href)
      if (name === 'distribution') url.searchParams.set('type', 'distribution')
      else url.searchParams.delete('type')
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  }

  function sourceItems() {
    return [...selected.values()].filter(item => item.type === 'source')
  }

  function setPackMode(name) {
    packMode = name === 'publish' ? 'publish' : 'local'
    for (const button of packModeButtons) button.setAttribute('aria-pressed', String(button.dataset.packMode === packMode))
    publicationFields.open = packMode === 'publish'
    for (const name of ['repository', 'maintainer', 'titleEn', 'summaryZh', 'summaryEn', 'compatibility', 'useCases']) {
      form.elements[name].required = packMode === 'publish'
    }
    previewMode.textContent = t(packMode === 'publish' ? 'distributionStudio.modePublish' : 'distributionStudio.modeLocal')
    renderTrust()
    setReady(false)
  }

  function slug(value, fallback = 'my-pack') {
    return String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback
  }

  function repositoryParts(value = form.elements.repository.value) {
    return /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(String(value).trim())
  }

  function assignSuggestion(input, value) {
    if (!input.value || input.value === input.dataset.generated) {
      input.value = value
      input.dataset.generated = value
    }
  }

  function suggestIdentity() {
    const parts = repositoryParts()
    if (!parts) return
    assignSuggestion(form.elements.id, slug(parts[2]))
    assignSuggestion(form.elements.maintainer, parts[1])
  }

  function releaseLabel(item) {
    const version = item.release.version || item.release.id.split('@').at(-1)
    return `${item.project.displayName} / ${version} / ${item.release.channel}`
  }

  function licenseFacts(expression, source) {
    const value = String(expression || 'NOASSERTION').trim() || 'NOASSERTION'
    const ids = value.replace(/[()]/g, ' ').split(/\s+(?:AND|OR|WITH)\s+|\s+/).filter(Boolean)
    const unknown = ids.length === 0 || ids.some(id => ['NOASSERTION', 'NONE', 'UNLICENSED'].includes(id))
    const custom = ids.some(id => id.startsWith('LicenseRef-'))
    const copy = ids.some(id => /^(?:A?GPL)-/.test(id))
    const weak = ids.some(id => /^(?:EPL|LGPL|MPL|CDDL)-/.test(id))
    const permissive = ids.length > 0 && ids.every(id => ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'ISC', 'MIT', 'MIT-0', 'NCSA', 'PostgreSQL', 'Python-2.0', 'Zlib'].includes(id))
    const publicDomain = ids.length > 0 && ids.every(id => ['CC0-1.0', 'Unlicense'].includes(id))
    const family = unknown ? 'unknown' : custom ? 'custom' : copy ? 'copyleft' : weak ? 'weak-copyleft' : permissive ? 'permissive' : publicDomain ? 'public-domain' : 'other'
    return {
      expression: value,
      family,
      review: ['unknown', 'custom', 'other'].includes(family) ? 'required' : 'notice',
      source,
      url: ids.length === 1 && !unknown && !custom
        ? `https://spdx.org/licenses/${encodeURIComponent(ids[0].replace(/\+$/, '-or-later'))}.html`
        : 'https://spdx.github.io/spdx-spec/v2.3/SPDX-license-expressions/',
    }
  }

  function validLicenseExpression(expression) {
    const value = String(expression).trim()
    const unknown = new Set(['NOASSERTION', 'NONE', 'UNLICENSED'])
    if (unknown.has(value)) return true
    const id = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|LicenseRef-[A-Za-z0-9.-]+)(?:\+)?$/
    const tokens = value.match(/\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+/g) || []
    let offset = 0
    function primary() {
      if (tokens[offset] === '(') {
        offset += 1
        disjunction()
        if (tokens[offset] !== ')') throw new Error()
        offset += 1
        return
      }
      if (!id.test(tokens[offset] || '') || unknown.has(tokens[offset])) throw new Error()
      offset += 1
      if (tokens[offset] === 'WITH') {
        offset += 1
        if (!id.test(tokens[offset] || '') || unknown.has(tokens[offset]) || tokens[offset].endsWith('+')) throw new Error()
        offset += 1
      }
    }
    function conjunction() { primary(); while (tokens[offset] === 'AND') { offset += 1; primary() } }
    function disjunction() { conjunction(); while (tokens[offset] === 'OR') { offset += 1; conjunction() } }
    try { disjunction(); return offset === tokens.length } catch { return false }
  }

  function renderPicker() {
    const current = picker.value
    picker.replaceChildren()
    picker.append(new Option(releases.length ? t('distributionStudio.chooseRelease') : t('distributionStudio.noEligibleReleases'), ''))
    for (const item of releases) {
      const option = new Option(releaseLabel(item), item.release.id)
      option.disabled = selected.has(`registry:${item.project.id}`)
      picker.append(option)
    }
    picker.value = [...selected.values()].some(item => item.release?.id === current) ? '' : current
    addButton.disabled = releases.length === 0
  }

  function componentLicense(item) {
    if (item.type === 'source') return licenseFacts(item.license.expression, item.license.source)
    return licenseFacts(item.release.license || item.project.license || 'NOASSERTION', 'registry')
  }

  function renderTrust() {
    const own = sourceItems().length
    const needsLicenseReview = [...selected.values()].some(item => componentLicense(item).review === 'required')
    if (packMode === 'publish' && own > 0) {
      trustLabel.textContent = t('distributionStudio.trustBlocked')
      trustLabel.dataset.state = 'blocked'
    } else if (own > 0 || needsLicenseReview) {
      trustLabel.textContent = t('distributionStudio.trustExperimental')
      trustLabel.dataset.state = 'review'
    } else {
      trustLabel.textContent = t('distributionStudio.trustRegistry')
      trustLabel.dataset.state = 'trusted'
    }
  }

  function renderLicenses() {
    licenseEmpty.hidden = selected.size > 0
    licenseList.innerHTML = [...selected.values()].map((item) => {
      const license = componentLicense(item)
      const id = item.type === 'source' ? item.id : item.project.id
      const source = item.type === 'source' ? `${item.source.repository}/tree/${item.source.ref}` : item.project.repository
      const sourceLabel = t(item.type === 'source' ? 'distributionStudio.sourceFixed' : 'distributionStudio.sourceRegistry')
      const review = t(license.review === 'required' ? 'distributionStudio.licenseReviewRequired' : 'distributionStudio.licenseNotice')
      return `<li><div><strong>${escapeHtml(id)}</strong><small>${escapeHtml(sourceLabel)}</small></div><a href="${escapeHtml(license.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(license.expression)}</a><span data-license-review="${escapeHtml(license.review)}">${escapeHtml(review)}</span><a class="pack-source-link" href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t('distributionStudio.viewSource'))}</a></li>`
    }).join('')
    renderTrust()
  }

  function renderItems() {
    empty.hidden = selected.size > 0
    itemList.innerHTML = [...selected.entries()].map(([key, item]) => {
      const name = item.type === 'source' ? item.id : item.project.displayName
      const detail = item.type === 'source'
        ? `${item.packageName}@${item.version} / ${item.license.expression}`
        : `${item.release.id} / ${item.release.license || item.project.license || 'NOASSERTION'}`
      const badge = t(item.type === 'source' ? 'distributionStudio.ownBadge' : 'distributionStudio.registryBadge')
      return `<li><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></span><em>${escapeHtml(badge)}</em><button type="button" data-remove-pack-item="${escapeHtml(key)}" aria-label="${escapeHtml(t('distributionStudio.remove'))}">×</button></li>`
    }).join('')
    renderPicker()
    renderLicenses()
  }

  function parseUseCases(value) {
    const lines = String(value).split('\n').map(line => line.trim()).filter(Boolean)
    if (lines.length < 1 || lines.length > 5) throw new Error(t('distributionStudio.invalidUseCases'))
    const ids = new Set()
    return lines.map((line, index) => {
      const parts = line.split('|').map(item => item.trim())
      if (parts.length !== 2 || parts.some(item => item === '')) throw new Error(t('distributionStudio.invalidUseCases'))
      let id = slug(parts[1], `use-case-${index + 1}`)
      if (ids.has(id)) id = `${id}-${index + 1}`
      ids.add(id)
      return { id, title: parts[0], translations: { en: parts[1] } }
    })
  }

  function manifestItems() {
    return [...selected.values()].map((item) => item.type === 'source' ? {
      type: 'source', id: item.id, packageName: item.packageName, version: item.version, enabled: true,
      license: item.license, source: item.source, install: item.install,
    } : { type: 'registry', projectId: item.project.id, releaseId: item.release.id, enabled: true })
  }

  function values() {
    if (selected.size === 0) throw new Error(t('distributionStudio.invalidItems'))
    if (packMode === 'local') {
      return {
        schema: 'omdsh-pack-source/v1', id: form.elements.id.value.trim(), version: form.elements.version.value.trim(),
        agentPreset: { mode: 'builtin', id: form.elements.agentPreset.value }, items: manifestItems(),
      }
    }
    if (sourceItems().length > 0) throw new Error(t('distributionStudio.publicOwnBlocked'))
    const repository = form.elements.repository.value.trim().replace(/\/$/, '')
    return {
      $schema: 'https://hub.0.org.cn/distribution.schema.json', schema: 'omdsh-distribution/v1',
      id: form.elements.id.value.trim(), version: form.elements.version.value.trim(), channel: form.elements.channel.value,
      title: form.elements.titleZh.value.trim(), summary: form.elements.summaryZh.value.trim(),
      translations: { en: { title: form.elements.titleEn.value.trim(), summary: form.elements.summaryEn.value.trim() } },
      maintainer: { name: form.elements.maintainer.value.trim(), url: repository },
      compatibility: { harness: 'official-profile/v1', declared: form.elements.compatibility.value.trim() },
      agentPreset: { mode: 'builtin', id: form.elements.agentPreset.value },
      useCases: parseUseCases(form.elements.useCases.value), items: manifestItems(),
      application: { candidate: 'required', confirmation: 'required', recovery: 'managed-profile-generation', externalSideEffects: 'not-covered' },
    }
  }

  function setReady(ready) {
    copyButton.disabled = !ready
    downloadButton.disabled = !ready
    copyCliButton.disabled = !ready
    const publishReady = ready && packMode === 'publish' && sourceItems().length === 0
    submission.classList.toggle('is-disabled', !publishReady)
    submission.setAttribute('aria-disabled', String(!publishReady))
    if (ready) preview.open = true
  }

  function ownPluginValue() {
    const byId = id => document.querySelector(id).value.trim()
    const repository = byId('#own-plugin-repository').replace(/\/$/, '')
    const parts = repositoryParts(repository)
    const ref = byId('#own-plugin-ref')
    if (!parts) throw new Error('自己的插件需要公开 GitHub 仓库。')
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('自己的插件必须固定到 40 位 commit SHA。')
    const id = byId('#own-plugin-id')
    const packageName = byId('#own-plugin-package')
    const version = byId('#own-plugin-version')
    const license = byId('#own-plugin-license')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('自己的插件需要合法组件 ID。')
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) throw new Error('自己的插件需要合法 npm 包名。')
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('自己的插件需要语义化版本。')
    if (!validLicenseExpression(license)) throw new Error(t('distributionStudio.invalidOwnLicense'))
    return {
      type: 'source', id, packageName, version, license: { expression: license, source: 'author-declared' },
      source: { repository, ref }, install: { mode: 'profile-bundle', spec: `github:${parts[1]}/${parts[2]}#${ref}` },
    }
  }

  modeButtons.forEach(button => button.addEventListener('click', () => setPublishPanel(button.dataset.publishMode)))
  packModeButtons.forEach(button => button.addEventListener('click', () => setPackMode(button.dataset.packMode)))
  form.elements.titleZh.addEventListener('input', () => assignSuggestion(form.elements.id, slug(form.elements.titleZh.value)))
  form.elements.repository.addEventListener('input', suggestIdentity)

  addButton.addEventListener('click', () => {
    const item = releases.find(candidate => candidate.release.id === picker.value)
    if (!item || selected.has(`registry:${item.project.id}`)) return
    selected.set(`registry:${item.project.id}`, { type: 'registry', ...item })
    renderItems()
  })
  addOwnButton.addEventListener('click', () => {
    error.hidden = true
    try {
      const item = ownPluginValue()
      const key = `source:${item.id}`
      if ([...selected.values()].some(value => (value.project?.id ?? value.id) === item.id)) throw new Error(`整合包中已经有 ${item.id}。`)
      selected.set(key, item)
      renderItems()
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : String(reason)
      error.hidden = false
    }
  })
  itemList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-pack-item]')
    if (!button) return
    selected.delete(button.dataset.removePackItem)
    renderItems()
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    error.hidden = true
    if (!form.reportValidity()) return
    try {
      manifest = values()
      output.textContent = JSON.stringify(manifest, null, 2)
      const suffix = manifest.schema === 'omdsh-pack-source/v1' ? 'pack.json' : 'distribution.json'
      cliCommand.textContent = `omdsh pack lock ${manifest.id}-${manifest.version}.${suffix} --output ${manifest.id}-${manifest.version}.dshpack`
      setReady(true)
    } catch (reason) {
      manifest = null
      setReady(false)
      error.textContent = reason instanceof Error ? reason.message : String(reason)
      error.hidden = false
    }
  })

  form.addEventListener('reset', () => queueMicrotask(() => {
    selected.clear(); manifest = null; output.textContent = '{}'; cliCommand.textContent = 'omdsh pack lock …'
    preview.open = false; error.hidden = true; setPackMode('local'); setReady(false); renderItems()
  }))
  copyButton.addEventListener('click', async () => {
    if (!manifest) return
    await navigator.clipboard.writeText(`${JSON.stringify(manifest, null, 2)}\n`)
    copyButton.textContent = t('publish.copied')
    setTimeout(() => { copyButton.textContent = t('publish.copy') }, 1600)
  })
  copyCliButton.addEventListener('click', async () => {
    if (!manifest) return
    await navigator.clipboard.writeText(cliCommand.textContent)
    copyCliButton.textContent = t('publish.copied')
    setTimeout(() => { copyCliButton.textContent = t('distributionStudio.copyCli') }, 1600)
  })
  downloadButton.addEventListener('click', () => {
    if (!manifest) return
    const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${manifest.id}-${manifest.version}.${manifest.schema === 'omdsh-pack-source/v1' ? 'pack' : 'distribution'}.json`
    anchor.click(); URL.revokeObjectURL(url)
  })
  submission.addEventListener('click', event => { if (!manifest || packMode !== 'publish' || sourceItems().length > 0) event.preventDefault() })
  document.addEventListener('dsh:locale', () => {
    previewMode.textContent = t(packMode === 'publish' ? 'distributionStudio.modePublish' : 'distributionStudio.modeLocal')
    renderItems()
    if (manifest) output.textContent = JSON.stringify(manifest, null, 2)
  })

  Promise.all([
    window.dshI18nReady,
    fetch('workshop-v1.json').then((response) => {
      if (!response.ok) throw new Error(`Workshop HTTP ${response.status}`)
      return response.json()
    }),
  ]).then(([, workshop]) => {
    releases = (workshop.projects || []).flatMap(project => (project.releases || [])
      .filter(release => release.state === 'active' && ['auto-listed', 'reviewed'].includes(release.listing?.state)
        && release.install?.mode === 'profile-bundle' && release.management?.mode === 'transactional')
      .map(release => ({ project, release }))).sort((left, right) => releaseLabel(left).localeCompare(releaseLabel(right)))
    setPackMode(packMode)
    renderItems()
    renderPicker()
  }).catch(() => { picker.replaceChildren(new Option(t('distributionStudio.loadFailed'), '')); addButton.disabled = true })

  const requestedMode = new URLSearchParams(location.search).get('type') === 'distribution' ? 'distribution' : 'project'
  setPublishPanel(requestedMode, false)
  setPackMode('local')
  renderItems()
})()
