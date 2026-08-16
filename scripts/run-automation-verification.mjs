#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { resolveDshBaseline } from './dsh-baseline-lib.mjs'
import { loadLoaderAdapter, readLoaderAdapterRegistry, resolveLoaderAdapter } from './loader-adapter-lib.mjs'
import { createHarnessPlan, runHarnessPlan, validateHarnessReport } from './typed-harness-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? null : process.argv[index + 1] || null
}

const releaseId = option('release')
const runtimeVersion = option('runtime')
const sourceRoot = option('source')
const previousSourceRoot = option('previous-source')
const trustSourceExecution = process.argv.includes('--trust-source-execution')
const force = process.argv.includes('--force')
if (!releaseId || !runtimeVersion || !sourceRoot) {
  throw new Error('usage: node scripts/run-automation-verification.mjs --release ID --runtime VERSION --source PATH [--previous-source PATH] [--trust-source-execution]')
}

const [record, currentBaseline, loaderRegistry] = await Promise.all([
  readFile(resolve(ROOT, 'intake/records', `${releaseId}.json`), 'utf8').then(JSON.parse),
  readFile(resolve(ROOT, 'official-baseline.json'), 'utf8').then(JSON.parse),
  readLoaderAdapterRegistry(resolve(ROOT, 'loader-adapters.json'))
])
const declaration = record.submission.manifest.packageManifest
const adapterName = declaration?.install?.adapter
const descriptorBeforeLoad = resolveLoaderAdapter(loaderRegistry, {
  installAdapter: adapterName,
  protocol: declaration.integration.protocol
})
if (descriptorBeforeLoad.execution === 'trusted-ephemeral' && !trustSourceExecution) {
  throw new Error(`${descriptorBeforeLoad.id} executes fixed source and requires explicit admission environment approval`)
}
const baseline = await resolveDshBaseline(runtimeVersion, currentBaseline)
const plan = createHarnessPlan(record.submission.manifest, baseline, descriptorBeforeLoad)
const current = runtimeVersion === currentBaseline.runtime.version
const planPath = current
  ? resolve(ROOT, 'intake/plans', `${releaseId}.json`)
  : resolve(ROOT, 'intake/compatibility', releaseId, `${runtimeVersion}.plan.json`)
const reportSuffix = record.classification.management === 'transactional' ? 'profile' : 'preflight'
const reportPath = current
  ? resolve(ROOT, 'intake/reports', `${releaseId}.${reportSuffix}.json`)
  : resolve(ROOT, 'intake/compatibility', releaseId, `${runtimeVersion}.report.json`)
await Promise.all([
  mkdir(resolve(planPath, '..'), { recursive: true }),
  mkdir(resolve(reportPath, '..'), { recursive: true })
])

if (!force) {
  const cached = await readFile(reportPath, 'utf8').then(JSON.parse).catch(() => null)
  if (cached?.status === 'passed' && validateHarnessReport(cached, plan).length === 0) {
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`)
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `report_path=${reportPath.replace(`${ROOT}/`, '')}\nstatus=${cached.status}\ncache_hit=true\n`)
    }
    console.log(`${releaseId} on @deepseek-ai/dsh@${runtimeVersion}: cache hit ${plan.evidenceKey}`)
    process.exit(0)
  }
}
const { descriptor, adapter } = await loadLoaderAdapter({
  root: ROOT,
  registry: loaderRegistry,
  installAdapter: adapterName,
  protocol: declaration.integration.protocol,
  context: {
    plan,
    declaration,
    sourceRoot: resolve(sourceRoot),
    sourceCommit: record.submission.ref,
    previousSourceRoot: previousSourceRoot ? resolve(previousSourceRoot) : null,
    pnpmStoreRoot: option('pnpm-store')
  }
})

const report = await runHarnessPlan(plan, adapter, {
  verifier: `github-actions-${descriptor.id}@${descriptor.version}-${runtimeVersion}`
})
await Promise.all([
  writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`),
  writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
])
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `report_path=${reportPath.replace(`${ROOT}/`, '')}\nstatus=${report.status}\ncache_hit=false\n`)
}
console.log(`${releaseId} on @deepseek-ai/dsh@${runtimeVersion}: ${report.status}; ${report.steps.filter((step) => step.status === 'passed').length}/${report.steps.length}`)
if (report.status !== 'passed') process.exitCode = 1
