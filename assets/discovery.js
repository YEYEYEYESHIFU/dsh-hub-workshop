(() => {
  const list = document.querySelector('#organization-project-list')
  const search = document.querySelector('#project-search')
  const empty = document.querySelector('#project-empty-state')
  const resultCount = document.querySelector('[data-project-result-count]')
  const ecosystemList = document.querySelector('#ecosystem-project-list')
  const ecosystemEmpty = document.querySelector('#ecosystem-empty-state')
  let projects = []
  let ecosystemProjects = []
  let ecosystemLayer = 'all'

  const isZh = () => document.documentElement.lang.startsWith('zh')

  function render() {
    const query = search.value.trim().toLocaleLowerCase()
    const filtered = projects.filter((repository) => repository.name.toLocaleLowerCase().includes(query))
    const fragment = document.createDocumentFragment()

    for (const repository of filtered) {
      const link = document.createElement('a')
      link.className = 'project-repository-card'
      link.href = repository.url

      const owner = document.createElement('span')
      owner.textContent = 'omdsh-dev'
      const name = document.createElement('strong')
      name.textContent = repository.name
      const action = document.createElement('small')
      action.textContent = isZh() ? '查看公开仓库' : 'View public repository'

      link.append(owner, name, action)
      fragment.append(link)
    }

    list.replaceChildren(fragment)
    list.setAttribute('aria-busy', 'false')
    resultCount.textContent = String(filtered.length)
    empty.hidden = filtered.length !== 0
  }

  function ecosystemSource(project) {
    const base = project.source?.repository || '#'
    return project.source?.ref ? `${base}/tree/${project.source.ref}` : base
  }

  function renderEcosystem() {
    const filtered = ecosystemLayer === 'all'
      ? ecosystemProjects
      : ecosystemProjects.filter((project) => project.layer === ecosystemLayer)
    const fragment = document.createDocumentFragment()

    for (const project of filtered) {
      const link = document.createElement('a')
      link.className = `ecosystem-project-card layer-${project.layer}`
      link.href = ecosystemSource(project)

      const meta = document.createElement('span')
      meta.className = 'ecosystem-project-meta'
      const layer = document.createElement('span')
      layer.textContent = project.layer === 'distribution'
        ? (isZh() ? '发行与组合' : 'Distribution')
        : (isZh() ? '生态基础设施' : 'Infrastructure')
      const stars = document.createElement('span')
      stars.textContent = `★ ${project.discovery?.stars || 0}`
      meta.append(layer, stars)

      const name = document.createElement('strong')
      name.textContent = project.name
      const description = document.createElement('p')
      description.textContent = project.description
      const footer = document.createElement('span')
      footer.className = 'ecosystem-project-footer'
      const author = document.createElement('span')
      author.textContent = project.author?.name || project.id.split('/')[0]
      const action = document.createElement('small')
      action.textContent = isZh() ? '查看固定来源 ↗' : 'View pinned source ↗'
      footer.append(author, action)

      link.append(meta, name, description, footer)
      fragment.append(link)
    }

    ecosystemList.replaceChildren(fragment)
    ecosystemList.setAttribute('aria-busy', 'false')
    ecosystemEmpty.hidden = filtered.length !== 0
    document.querySelectorAll('[data-ecosystem-layer]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.ecosystemLayer === ecosystemLayer))
    })
  }

  search.addEventListener('input', render)
  document.querySelectorAll('[data-ecosystem-layer]').forEach((button) => {
    button.addEventListener('click', () => {
      ecosystemLayer = button.dataset.ecosystemLayer
      renderEcosystem()
    })
  })
  document.addEventListener('dsh:locale', () => {
    render()
    renderEcosystem()
  })

  Promise.all([
    fetch('public-discovery.json'),
    fetch('market-layers.json'),
  ])
    .then(async ([discoveryResponse, marketResponse]) => {
      if (!discoveryResponse.ok) throw new Error(`Discovery HTTP ${discoveryResponse.status}`)
      if (!marketResponse.ok) throw new Error(`Market HTTP ${marketResponse.status}`)
      return Promise.all([discoveryResponse.json(), marketResponse.json()])
    })
    .then(([data, market]) => {
      projects = data.organization.repositories.filter((repository) => repository.kind === 'public-project')
      ecosystemProjects = market.projects || []
      document.querySelectorAll('[data-project-count]').forEach((node) => { node.textContent = String(projects.length) })
      document.querySelectorAll('[data-topic-count]').forEach((node) => { node.textContent = String(data.topic.observedRepositoryCount) })
      document.querySelectorAll('[data-market-project-count]').forEach((node) => { node.textContent = String(ecosystemProjects.length) })
      document.querySelectorAll('[data-ecosystem-layer-count]').forEach((node) => {
        const layer = node.dataset.ecosystemLayerCount
        node.textContent = String(layer === 'all'
          ? ecosystemProjects.length
          : ecosystemProjects.filter((project) => project.layer === layer).length)
      })
      render()
      renderEcosystem()
    })
    .catch(() => {
      list.setAttribute('aria-busy', 'false')
      list.replaceChildren()
      empty.hidden = false
      empty.querySelector('strong').textContent = '项目清单暂时无法加载'
      empty.querySelector('p').textContent = '请稍后重试，或直接访问 omdsh-dev 的 GitHub 组织页面。'
      ecosystemList.setAttribute('aria-busy', 'false')
      ecosystemList.replaceChildren()
      ecosystemEmpty.hidden = false
    })
})()
