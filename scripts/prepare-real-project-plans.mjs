#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { createIntakeRecord } from './intake-lib.mjs'
import { parseLegacySource } from './real-project-review-lib.mjs'
import { createHarnessPlan } from './typed-harness-lib.mjs'
import { capabilityProfile } from './workshop-manifest-lib.mjs'

const exec = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const projectIndex = args.indexOf('--project')
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : null
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const PREVIOUS_RELEASES = new Map([
  ['7d7d', { version: '0.4.0-rc.1', ref: '80b6ddb779a009d378a1c30c85dfef598f527997' }],
  ['session-teleport', { version: '0.6.0-rc.1', ref: 'd76e0d98b09ad1d08f2592ffd47161acb907bfc4' }],
])

function usage() {
  console.error('Usage: node scripts/prepare-real-project-plans.mjs [--project id] --checkout owner/repository=/absolute/path [--checkout ...]')
  process.exitCode = 2
}

function normalizedRemote(value) {
  return String(value || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
}

function repositoryKey(url) {
  return new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLocaleLowerCase('en-US')
}

function checkoutArguments() {
  const checkouts = new Map()
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--checkout') continue
    const value = args[index + 1] || ''
    const separator = value.indexOf('=')
    if (separator < 1 || !value.slice(separator + 1).startsWith('/')) throw new Error(`invalid checkout coordinate: ${value}`)
    checkouts.set(value.slice(0, separator).toLocaleLowerCase('en-US'), value.slice(separator + 1))
    index += 1
  }
  return checkouts
}

async function git(checkout, gitArgs) {
  const { stdout } = await exec('git', ['-C', checkout, ...gitArgs], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: process.env.LANG || 'C.UTF-8' },
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

async function verifyCheckout(checkout, source) {
  const [head, status, origin] = await Promise.all([
    git(checkout, ['rev-parse', 'HEAD']),
    git(checkout, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(checkout, ['remote', 'get-url', 'origin']),
  ])
  if (head !== source.ref) throw new Error(`${source.repository}: checkout HEAD ${head} does not match ${source.ref}`)
  if (status) throw new Error(`${source.repository}: checkout is not clean`)
  if (normalizedRemote(origin) !== normalizedRemote(source.repository)) throw new Error(`${source.repository}: checkout origin mismatch`)
}

function submissionFor(project, source, packageJson) {
  const declaration = packageJson.dshWorkshop
  const profile = declaration.install.adapter === 'profile-bundle'
  const previous = profile ? PREVIOUS_RELEASES.get(project.id) : null
  if (profile && !previous) throw new Error(`${project.id}: previous release coordinate is required`)
  const owner = repositoryKey(source.repository).split('/')[0]
  return {
    schema: 'omdsh-workshop-submission/v2',
    operation: 'add-release',
    project: {
      id: project.id,
      displayName: project.name,
      summary: project.description,
      kind: project.kind,
      category: project.category,
      tags: project.tags,
      repository: source.repository,
      path: source.path,
      author: project.author || { name: owner, url: `https://github.com/${owner}` },
      license: project.license,
    },
    release: {
      version: packageJson.version,
      ref: source.ref,
      updatedAt: project.updatedAt,
      channel: packageJson.version.includes('-') ? 'beta' : 'stable',
      compatibility: 'Exact @deepseek-ai/dsh@0.1.0-rc.6 Harness evaluation.',
      changelog: 'Migrated to the current typed Workshop contract and fixed public source.',
      capabilities: {
        requiresFabric: false,
        deepHook: false,
        restartRequired: declaration.lifecycle.activation.startsWith('restart-'),
      },
      profileBundle: profile ? {
        packageName: packageJson.name,
        spec: `github:${repositoryKey(source.repository)}#${source.ref}`,
      } : null,
      updateFrom: previous,
    },
    management: {
      method: profile ? 'profile-bundle' : 'guided',
      protocol: declaration.integration.protocol,
      label: profile ? 'Transactional candidate Profile review' : declaration.integration.protocol === 'mcp' ? 'Isolated MCP review' : 'Static Skill review',
      instructions: profile
        ? 'Evaluate the fixed Profile Bundle in an ephemeral candidate generation.'
        : declaration.integration.protocol === 'mcp'
          ? 'Review the fixed MCP server in an isolated process after explicit trust approval.'
          : 'Inspect the fixed Skill bundle statically without executing its instructions.',
      source: null,
    },
    declarations: {
      permissions: declaration.permissions.length ? declaration.permissions.join(', ') : 'none',
      testing: 'Run the typed adapter against this exact source and preserve the complete report.',
      trustedPublisherRequested: false,
      installScriptsMustRemainDisabled: true,
    },
    packageManifest: declaration,
  }
}

const checkouts = checkoutArguments()
if (checkouts.size === 0) {
  usage()
} else {
  const [catalog, admissions, baseline] = await Promise.all([
    json('catalog.json'),
    json('registry-admissions.json'),
    json('official-baseline.json'),
  ])
  const projects = new Map(catalog.packages.map((project) => [project.id, project]))
  await Promise.all(['intake/plans', 'intake/records'].map((path) => mkdir(resolve(ROOT, path), { recursive: true })))
  for (const blocked of admissions.blocked) {
    if (projectId && blocked.id !== projectId) continue
    const project = projects.get(blocked.id)
    if (!project) throw new Error(`${blocked.id}: missing Catalog project`)
    const source = parseLegacySource(blocked.source)
    const checkout = checkouts.get(repositoryKey(source.repository))
    if (!checkout) throw new Error(`${blocked.id}: no checkout supplied for ${repositoryKey(source.repository)}`)
    await verifyCheckout(checkout, source)
    const sourceRoot = source.path ? join(checkout, source.path.replace(/^\//, '')) : checkout
    const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
    if (project.version !== packageJson.version || project.ref !== source.ref) throw new Error(`${blocked.id}: Catalog release facts do not match the fixed package`)
    const submission = submissionFor(project, source, packageJson)
    const record = createIntakeRecord(submission, baseline)
    const plan = createHarnessPlan(submission, baseline)
    project.workshop = capabilityProfile({ declaration: packageJson.dshWorkshop })
    await Promise.all([
      writeFile(resolve(ROOT, 'intake/records', `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
      writeFile(resolve(ROOT, 'intake/plans', `${plan.releaseId}.json`), `${JSON.stringify(plan, null, 2)}\n`, 'utf8'),
    ])
    console.log(`${project.id}: ${plan.classification.protocol}/${plan.classification.adapter}; ${plan.steps.length} step(s); execution ${plan.policy.sourceExecution}`)
  }
  await writeFile(resolve(ROOT, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}
