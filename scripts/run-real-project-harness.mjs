#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createMcpProcessAdapter, createRc6ProfileAdapter, createSkillStaticAdapter } from './harness-adapters.mjs'
import { runHarnessPlan } from './typed-harness-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const kindIndex = args.indexOf('--kind')
const kind = kindIndex >= 0 ? args[kindIndex + 1] : null
const projectIndex = args.indexOf('--project')
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : null
const runtimeBlockIndex = args.indexOf('--runtime-blocked-reason')
const runtimeBlockReason = runtimeBlockIndex >= 0 ? args[runtimeBlockIndex + 1] : null
const pnpmStoreIndex = args.indexOf('--pnpm-store')
const pnpmStoreRoot = pnpmStoreIndex >= 0 ? args[pnpmStoreIndex + 1] : null
const keepWorkspace = args.includes('--keep-workspace')
const trustSourceExecution = args.includes('--trust-source-execution')
const TOOL_ARGUMENTS = new Map([
  ['almanac-mcp', { date: '2030-01-15' }],
  ['chinese-colors-mcp', { keyword: '黛' }],
  ['decision-dice-mcp', { seed: 'verify' }],
  ['naming-master-mcp', {}],
  ['time-capsule-mcp', {}],
])

function usage() {
  console.error('Usage: node scripts/run-real-project-harness.mjs --kind skill|mcp|profile [--project id] --checkout owner/repository=/absolute/path [--previous-checkout owner/repository=/absolute/path] [--previous-binding-checkout owner/repository=/absolute/path] [--pnpm-store /absolute/path] [--runtime-blocked-reason reason] [--keep-workspace] [--trust-source-execution]')
  process.exitCode = 2
}

function repositoryKey(url) {
  return new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/').toLocaleLowerCase('en-US')
}

function checkoutArguments(flag = '--checkout') {
  const checkouts = new Map()
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1] || ''
    const separator = value.indexOf('=')
    if (separator < 1 || !value.slice(separator + 1).startsWith('/')) throw new Error(`invalid checkout coordinate: ${value}`)
    checkouts.set(value.slice(0, separator).toLocaleLowerCase('en-US'), value.slice(separator + 1))
    index += 1
  }
  return checkouts
}

async function serverEntry(sourceRoot) {
  const entries = (await readdir(join(sourceRoot, 'server'))).filter((name) => name.endsWith('.mjs')).sort()
  if (entries.length !== 1) throw new Error(`${sourceRoot}: expected exactly one bundled MCP server entry`)
  return join(sourceRoot, 'server', entries[0])
}

if (!['skill', 'mcp', 'profile'].includes(kind || '')) {
  usage()
} else if (['mcp', 'profile'].includes(kind) && !trustSourceExecution) {
  throw new Error(`${kind} Harness executes fixed source and requires --trust-source-execution after explicit human approval`)
} else {
  const checkouts = checkoutArguments()
  const previousCheckouts = checkoutArguments('--previous-checkout')
  const previousBindingCheckouts = checkoutArguments('--previous-binding-checkout')
  const planFiles = (await readdir(resolve(ROOT, 'intake/plans'))).filter((name) => name.endsWith('.json')).sort()
  await mkdir(resolve(ROOT, 'intake/reports'), { recursive: true })
  let failures = 0
  for (const file of planFiles) {
    const plan = JSON.parse(await readFile(resolve(ROOT, 'intake/plans', file), 'utf8'))
    if (projectId && plan.projectId !== projectId) continue
    if (kind === 'profile' ? plan.classification.adapter !== 'profile-bundle' : plan.classification.protocol !== kind) continue
    const key = repositoryKey(plan.source.repository)
    const checkout = checkouts.get(key)
    if (!checkout) throw new Error(`${plan.projectId}: no checkout supplied for ${key}`)
    const sourceRoot = plan.source.path ? join(checkout, plan.source.path.replace(/^\//, '')) : checkout
    const adapter = kind === 'skill'
      ? await createSkillStaticAdapter({ plan, sourceRoot, sourceCommit: plan.source.ref })
      : kind === 'mcp' ? await createMcpProcessAdapter({
          plan,
          sourceRoot,
          sourceCommit: plan.source.ref,
          args: [await serverEntry(sourceRoot)],
          toolArguments: TOOL_ARGUMENTS.get(plan.projectId) || {},
        })
        : await createRc6ProfileAdapter({
            plan,
            sourceRoot,
            sourceCommit: plan.source.ref,
            previousSourceRoot: previousCheckouts.get(key),
            previousSourceCommit: plan.updateFrom?.ref,
            previousSourceBindingRoot: previousBindingCheckouts.get(key) || null,
            runtimeBlockReason,
            pnpmStoreRoot,
            keepWorkspace,
          })
    const report = await runHarnessPlan(plan, adapter, {
      verifier: kind === 'skill'
        ? 'local-fixed-checkout-skill-static'
        : kind === 'mcp'
          ? 'local-fixed-checkout-mcp-preflight'
          : 'local-fixed-checkout-rc6-profile',
    })
    const output = resolve(ROOT, 'intake/reports', `${plan.releaseId}.${kind === 'profile' ? 'profile' : 'preflight'}.json`)
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`${plan.projectId}: ${report.status}; ${report.steps.filter((step) => step.status === 'passed').length}/${report.steps.length}; ${output.replace(`${ROOT}/`, '')}`)
    if (report.status !== 'passed') failures += 1
  }
  if (failures) process.exitCode = 1
}
