import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { createIntakeRecord, validateSubmission } from './intake-lib.mjs'
import { createHarnessPlan } from './typed-harness-lib.mjs'
import { validateOfficialMcpManifest } from './workshop-manifest-lib.mjs'

const MAX_ISSUE_BODY_BYTES = 128 * 1024
const SUBMISSION_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/gi
const REPOSITORY_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/
const MANAGED_SOURCE_RE = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9a-f]{40}&path:\/(.+)$/

function requestHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'omdsh-workshop-intake',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function githubJson(url, { fetchImpl, token, description }) {
  const response = await fetchImpl(url, { headers: requestHeaders(token) })
  if (!response.ok) throw new Error(`${description} failed with GitHub HTTP ${response.status}`)
  return response.json()
}

function encodedPath(value) {
  return String(value).split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function joinedRepositoryPath(root, child) {
  return `/${[String(root || '').replace(/^\/+|\/+$/g, ''), String(child || '').replace(/^\/+/, '')].filter(Boolean).join('/')}`
}

function decodedGithubFile(value, name) {
  if (value?.type !== 'file' || value.encoding !== 'base64' || typeof value.content !== 'string') {
    throw new Error(`${name} is not a readable file at the fixed commit`)
  }
  return Buffer.from(value.content.replace(/\s/g, ''), 'base64').toString('utf8')
}

export function extractSubmissionManifest(body) {
  if (typeof body !== 'string' || body.length === 0) throw new Error('submission Issue body is empty')
  if (Buffer.byteLength(body, 'utf8') > MAX_ISSUE_BODY_BYTES) throw new Error('submission Issue body exceeds 128 KiB')
  for (const match of body.matchAll(SUBMISSION_FENCE_RE)) {
    let candidate
    try {
      candidate = JSON.parse(match[1])
    } catch {
      continue
    }
    if (['omdsh-workshop-submission/v1', 'omdsh-workshop-submission/v2'].includes(candidate?.schema)) return candidate
  }
  throw new Error('Issue does not contain an omdsh-workshop-submission/v1 or v2 JSON code block')
}

export async function verifyPublicSubmissionSource(manifest, { fetchImpl = fetch, token = '' } = {}) {
  const repository = REPOSITORY_RE.exec(manifest.project.repository)
  if (!repository) throw new Error('submission repository is not a supported GitHub URL')
  const [, owner, name] = repository
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
  const repositoryFacts = await githubJson(apiBase, {
    fetchImpl,
    token,
    description: 'public repository lookup',
  })
  if (repositoryFacts.private !== false) throw new Error('submission repository must be public')
  if (repositoryFacts.disabled === true) throw new Error('submission repository is disabled')

  const commit = await githubJson(`${apiBase}/git/commits/${manifest.release.ref}`, {
    fetchImpl,
    token,
    description: 'fixed commit lookup',
  })
  if (commit.sha !== manifest.release.ref) throw new Error('fixed commit did not resolve exactly')

  const paths = new Set()
  if (manifest.project.path) paths.add(manifest.project.path)
  if (manifest.management.method === 'repository-plugin') {
    const source = MANAGED_SOURCE_RE.exec(manifest.management.source || '')
    if (!source) throw new Error('Repository Plugin source path is invalid')
    paths.add(`/${source[1]}`)
  }
  const fileFacts = new Map()
  if (manifest.schema === 'omdsh-workshop-submission/v2') {
    const packageJsonPath = joinedRepositoryPath(manifest.project.path, 'package.json')
    paths.add(packageJsonPath)
    paths.add(joinedRepositoryPath(manifest.project.path, manifest.packageManifest.integration.artifact))
    for (const path of Object.values(manifest.packageManifest.evidence)) {
      if (path) paths.add(joinedRepositoryPath(manifest.project.path, path))
    }
  }
  for (const path of paths) {
    const value = await githubJson(`${apiBase}/contents/${encodedPath(path)}?ref=${manifest.release.ref}`, {
      fetchImpl,
      token,
      description: `fixed source path ${path}`,
    })
    fileFacts.set(path, value)
  }
  if (manifest.schema === 'omdsh-workshop-submission/v2') {
    const packageJsonPath = joinedRepositoryPath(manifest.project.path, 'package.json')
    let packageJson
    try {
      packageJson = JSON.parse(decodedGithubFile(fileFacts.get(packageJsonPath), 'package.json'))
    } catch (error) {
      throw new Error(`fixed package.json is invalid: ${error.message}`)
    }
    if (!isDeepStrictEqual(packageJson.dshWorkshop, manifest.packageManifest)) {
      throw new Error('submission packageManifest does not match fixed package.json#dshWorkshop')
    }
    if (packageJson.version !== manifest.release.version) throw new Error('submitted release version does not match fixed package.json')
    if (manifest.release.profileBundle && packageJson.name !== manifest.release.profileBundle.packageName) {
      throw new Error('Profile Bundle package name does not match fixed package.json')
    }
    if (manifest.release.updateFrom) {
      const previousCommit = await githubJson(`${apiBase}/git/commits/${manifest.release.updateFrom.ref}`, {
        fetchImpl,
        token,
        description: 'fixed previous release commit lookup',
      })
      if (previousCommit.sha !== manifest.release.updateFrom.ref) throw new Error('fixed previous release commit did not resolve exactly')
      const previousPackageValue = await githubJson(`${apiBase}/contents/${encodedPath(packageJsonPath)}?ref=${manifest.release.updateFrom.ref}`, {
        fetchImpl,
        token,
        description: `fixed previous package.json ${packageJsonPath}`,
      })
      let previousPackageJson
      try {
        previousPackageJson = JSON.parse(decodedGithubFile(previousPackageValue, 'previous package.json'))
      } catch (error) {
        throw new Error(`fixed previous package.json is invalid: ${error.message}`)
      }
      if (previousPackageJson.name !== packageJson.name || previousPackageJson.version !== manifest.release.updateFrom.version) {
        throw new Error('previous package identity/version does not match the declared update origin')
      }
    }
    if (manifest.packageManifest.integration.protocol === 'mcp') {
      const serverPath = joinedRepositoryPath(manifest.project.path, manifest.packageManifest.integration.mcp.serverManifest)
      let serverManifest
      try {
        serverManifest = JSON.parse(decodedGithubFile(fileFacts.get(serverPath), 'MCP server.json'))
      } catch (error) {
        throw new Error(`fixed MCP server.json is invalid: ${error.message}`)
      }
      const errors = validateOfficialMcpManifest({ packageJson, serverManifest, declaration: manifest.packageManifest })
      if (errors.length) throw new Error(errors.join('\n'))
    }
  }

  return {
    repository: repositoryFacts.html_url || manifest.project.repository.replace(/\/$/, ''),
    ref: commit.sha,
    paths: [...paths].sort(),
    updateFrom: manifest.release.updateFrom ? structuredClone(manifest.release.updateFrom) : null,
    archived: repositoryFacts.archived === true,
  }
}

export async function prepareIssueIntake(event, { root, fetchImpl = fetch, token = '' } = {}) {
  if (!event?.issue || event.issue.pull_request) throw new Error('event is not a GitHub Issue')
  if (!/^\[Submission\](?:\s|$)/.test(event.issue.title || '')) throw new Error('Issue title is not an extension submission')
  const manifest = extractSubmissionManifest(event.issue.body)
  const errors = validateSubmission(manifest)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  const baseline = JSON.parse(await readFile(resolve(root, 'official-baseline.json'), 'utf8'))
  const record = createIntakeRecord(manifest, baseline)
  const recordPath = resolve(root, 'intake/records', `${record.id}.json`)
  const plan = manifest.schema === 'omdsh-workshop-submission/v2' ? createHarnessPlan(manifest, baseline) : null
  const planPath = plan ? resolve(root, 'intake/plans', `${record.id}.json`) : null
  try {
    await readFile(recordPath)
    throw new Error(`${record.id}: an intake record already exists`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (planPath) {
    try {
      await readFile(planPath)
      throw new Error(`${record.id}: a typed Harness plan already exists`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const source = await verifyPublicSubmissionSource(manifest, { fetchImpl, token })
  record.review.notes = `Automatically prepared from #${event.issue.number}; public fixed-source preflight passed. Human review is still required.`
  record.tests.static.evidence = `submission manifest validation; public repository and fixed commit resolved${source.paths.length ? `; pinned path(s): ${source.paths.join(', ')}` : ''}`
  return { manifest, record, recordPath, plan, planPath, source }
}
