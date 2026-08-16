#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { importAwesomeRadarSnapshot } from './external-evidence-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const option = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}
const config = JSON.parse(await readFile(resolve(ROOT, 'external-evidence-sources.json'), 'utf8'))
if (config.schema !== 'omdsh-supplemental-evidence-sources/v1' || config.providers.length !== 1) {
  throw new Error('exactly one supported external evidence provider is required')
}
const provider = config.providers[0]

function headers() {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'omdsh-hub-external-evidence/1.0',
    'x-github-api-version': '2022-11-28',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  }
}

async function githubJson(url) {
  const response = await fetch(url, { headers: headers() })
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${url}`)
  return response.json()
}

async function remoteArtifact() {
  const repository = new URL(provider.repository).pathname.split('/').filter(Boolean).join('/')
  const api = `https://api.github.com/repos/${repository}`
  const commit = await githubJson(`${api}/commits/${encodeURIComponent(provider.ref)}`)
  if (!/^[0-9a-f]{40}$/.test(commit.sha || '')) throw new Error('provider ref did not resolve to a full commit')
  const tree = await githubJson(`${api}/git/trees/${commit.sha}?recursive=1`)
  if (tree.truncated) throw new Error('provider tree response is truncated')
  const artifactPattern = new RegExp(provider.artifacts.pattern)
  const paths = tree.tree.map((entry) => entry.path)
    .filter((path) => path.startsWith(`${provider.artifacts.directory}/`) && artifactPattern.test(path))
  const artifactPath = paths.sort().at(-1)
  if (!artifactPath) throw new Error('provider snapshot artifact was not found')
  const raw = `https://raw.githubusercontent.com/${repository}/${commit.sha}/${artifactPath}`
  const response = await fetch(raw, { headers: { 'user-agent': 'omdsh-hub-external-evidence/1.0' } })
  if (!response.ok) throw new Error(`provider artifact HTTP ${response.status}`)
  return { sourceCommit: commit.sha, artifactPath, artifactBytes: Buffer.from(await response.arrayBuffer()) }
}

let artifact
const localSnapshot = option('snapshot')
if (localSnapshot) {
  const sourceCommit = option('source-commit')
  const artifactPath = option('artifact-path') || localSnapshot
  if (!sourceCommit) throw new Error('--source-commit is required with --snapshot')
  artifact = { sourceCommit, artifactPath, artifactBytes: await readFile(resolve(localSnapshot)) }
} else {
  artifact = await remoteArtifact()
}
const snapshot = JSON.parse(artifact.artifactBytes.toString('utf8'))
const output = importAwesomeRadarSnapshot({ provider, snapshot, ...artifact })
const target = resolve(ROOT, 'external-evidence.json')
const temporary = `${target}.tmp-${process.pid}`
await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`)
await rename(temporary, target)
console.log(`synced ${output.summary.observations}/${output.summary.rawEntries} external observations from ${output.providers[0].sourceCommit}`)
