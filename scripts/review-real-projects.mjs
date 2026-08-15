#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { inspectRealProject, parseLegacySource, reviewDigest } from './real-project-review-lib.mjs'

const exec = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const idIndex = args.indexOf('--id')
const selectedId = idIndex >= 0 ? args[idIndex + 1] : null
const indexOnly = args.includes('--index-only')
const reviewedAt = new Date().toISOString()
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'))
const gitEnvironment = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  LANG: process.env.LANG || 'C.UTF-8',
  LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/usr/bin/false',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function applySupplementalRc6Evidence(review) {
  const path = resolve(ROOT, 'intake/reports', `${review.releaseId}.rc6-alignment.json`)
  let evidence
  try {
    evidence = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return review
    throw error
  }
  if (evidence.schema !== 'omdsh-workshop-rc6-alignment-evidence/v1'
    || evidence.releaseId !== review.releaseId
    || evidence.source?.ref !== review.source.ref
    || evidence.baseline?.package !== '@deepseek-ai/dsh'
    || evidence.baseline?.version !== '0.1.0-rc.6') {
    throw new Error(`${review.id}: supplemental RC.6 evidence does not match the fixed review coordinates`)
  }
  if (evidence.decision?.state === 'blocked-source-fix-required') {
    const code = evidence.fixedSourceRun?.rootCause?.code || 'supplemental-rc6-alignment-failed'
    if (!review.trustReview.findings.some((finding) => finding.code === code)) {
      review.trustReview.findings.push({
        severity: 'blocker',
        code,
        evidence: `The exact RC.6 fixed-source suite passed ${evidence.fixedSourceRun.testsPassed} test(s) and failed ${evidence.fixedSourceRun.testsFailed}; an isolated candidate fixture fix passed ${evidence.candidateFixValidation.testsPassed}/${evidence.candidateFixValidation.testsPassed + evidence.candidateFixValidation.testsFailed} but is not admission evidence.`,
      })
    }
    review.trustReview.state = 'needs-fix'
    review.trustReview.checks.rc6Alignment = 'failed'
    review.sequence.find((item) => item.stage === 'trust-review').reason = `Assisted static and supplemental RC.6 review recorded ${review.trustReview.findings.length} finding(s) without granting admission.`
    review.sequence.find((item) => item.stage === 'adapter').reason = 'The fixed release has unresolved RC.6 alignment evidence and cannot authorize its adapter.'
    review.adapter.reason = 'Blocked until a new fixed release resolves the supplemental RC.6 alignment finding and receives explicit human trust approval.'
    review.admission.reason = 'The fixed release has a failing RC.6 alignment test and no approved human review.'
  }
  return review
}

async function git(args, options = {}) {
  return exec('git', args, {
    ...options,
    env: gitEnvironment,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 600_000,
  })
}

async function publicGit(args, options = {}) {
  let lastError
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await git(['-c', 'http.version=HTTP/1.1', '-c', 'credential.helper=', ...args], options)
    } catch (error) {
      lastError = error
      const detail = `${error?.message || ''}\n${error?.stderr || ''}`
      const retryable = error?.killed === true
        || error?.signal === 'SIGTERM'
        || /(?:HTTP2 framing|Failed to connect|Connection reset|Empty reply|Recv failure|Operation timed out|timed out|TLS connection)/i.test(detail)
      if (!retryable || attempt === 5) throw error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 500))
    }
  }
  throw lastError
}

async function publicCheckout(source, destination) {
  const { stdout: remote } = await publicGit(['ls-remote', source.repository, 'HEAD'])
  const observedDefaultHead = remote.trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(observedDefaultHead || '')) throw new Error(`${source.repository}: anonymous public HEAD did not resolve`)
  await mkdir(destination, { recursive: true })
  await git(['init', '--quiet', destination])
  await git(['-C', destination, 'remote', 'add', 'origin', source.repository])
  await publicGit(['-C', destination, 'fetch', '--quiet', '--depth=1', 'origin', source.ref])
  await git(['-C', destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'])
  const { stdout: head } = await git(['-C', destination, 'rev-parse', 'HEAD'])
  if (head.trim() !== source.ref) throw new Error(`${source.repository}: fetched ${head.trim()} instead of ${source.ref}`)
  const { stdout: status } = await git(['-C', destination, 'status', '--porcelain=v1', '--untracked-files=all'])
  if (status.trim()) throw new Error(`${source.repository}: fixed checkout is not clean`)
  return { observedDefaultHead }
}

async function publicTree(checkoutRoot, sourcePath) {
  const treeSpec = sourcePath ? `HEAD:${sourcePath.replace(/^\//, '')}` : 'HEAD^{tree}'
  const { stdout } = await git(['-C', checkoutRoot, 'rev-parse', treeSpec])
  return stdout.trim()
}

async function rebuildIndex(currentReleaseIds) {
  const directory = resolve(ROOT, 'intake/reviews')
  const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  const records = []
  for (const file of files) {
    const review = JSON.parse(await readFile(join(directory, file), 'utf8'))
    if (!currentReleaseIds.has(review.releaseId)) continue
    records.push({
      id: review.id,
      releaseId: review.releaseId,
      file: `intake/reviews/${file}`,
      sha256: reviewDigest(review),
      fixedSource: review.sequence[0].state,
      typePlan: review.typePlan.state,
      trustReview: review.trustReview.state,
      adapter: review.adapter.state,
      humanReview: review.humanReview.state,
      admission: review.admission.state,
      rc6Verified: review.claims.rc6Verified,
    })
  }
  const index = {
    schema: 'omdsh-workshop-real-project-review-index/v1',
    generatedAt: reviewedAt,
    baseline: '@deepseek-ai/dsh@0.1.0-rc.6',
    policy: {
      sequential: true,
      sourceExecutionRequiresHumanTrust: true,
      independentHumanReviewRequired: true,
      admissionIsSeparate: true,
    },
    summary: {
      projects: records.length,
      fixedSources: records.filter((item) => item.fixedSource === 'passed').length,
      typePlansReady: records.filter((item) => item.typePlan === 'ready').length,
      adaptersPassed: records.filter((item) => item.adapter === 'passed').length,
      humanReviewsApproved: records.filter((item) => item.humanReview === 'approved').length,
      admissions: records.filter((item) => item.admission === 'admitted').length,
      rc6Verified: records.filter((item) => item.rc6Verified).length,
    },
    records,
  }
  await writeFile(resolve(ROOT, 'intake/real-project-review-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  return index
}

const [catalog, admissions] = await Promise.all([json('catalog.json'), json('registry-admissions.json')])
const packages = new Map(catalog.packages.map((item) => [item.id, item]))
let candidates = admissions.blocked.map((blocked) => {
  const project = packages.get(blocked.id)
  if (!project) throw new Error(`${blocked.id}: blocked source has no Catalog project`)
  return {
    id: project.id,
    source: blocked.source,
    mode: blocked.mode,
    version: project.version,
    license: project.license,
    kind: project.kind,
  }
})
const currentReleaseIds = new Set(candidates.map((item) => `${item.id}@${item.version}`))
if (selectedId) candidates = candidates.filter((item) => item.id === selectedId)
if (indexOnly) candidates = []
if (selectedId && candidates.length === 0) throw new Error(`unknown blocked real project: ${selectedId}`)

await mkdir(resolve(ROOT, 'intake/reviews'), { recursive: true })
const checkouts = new Map()
let reviewError = null
try {
  for (const candidate of candidates) {
    const source = parseLegacySource(candidate.source)
    const checkoutKey = `${source.repository}#${source.ref}`
    let checkout = checkouts.get(checkoutKey)
    if (!checkout) {
      const temporaryRoot = await mkdtemp(join(tmpdir(), `omdsh-real-review-${candidate.id}-`))
      const checkoutRoot = join(temporaryRoot, 'source')
      const publicGit = await publicCheckout(source, checkoutRoot)
      checkout = { temporaryRoot, checkoutRoot, ...publicGit }
      checkouts.set(checkoutKey, checkout)
    }
    const tree = await publicTree(checkout.checkoutRoot, source.path)
    const review = await applySupplementalRc6Evidence(await inspectRealProject({ candidate, checkoutRoot: checkout.checkoutRoot, observedDefaultHead: checkout.observedDefaultHead, tree, reviewedAt }))
    const output = resolve(ROOT, 'intake/reviews', `${review.releaseId}.json`)
    await writeFile(output, `${JSON.stringify(review, null, 2)}\n`, 'utf8')
    console.log(`${review.id}: fixed ${review.source.ref}; plan ${review.typePlan.state}; adapter ${review.adapter.state}; RC.6 verified=false`)
  }
} catch (error) {
  reviewError = error
} finally {
  await Promise.all([...checkouts.values()].map((checkout) => rm(checkout.temporaryRoot, { recursive: true, force: true })))
}

const index = await rebuildIndex(currentReleaseIds)
console.log(`real-project reviews saved: ${index.summary.projects}; type plans ready ${index.summary.typePlansReady}; adapters passed ${index.summary.adaptersPassed}; admissions ${index.summary.admissions}; RC.6 verified ${index.summary.rc6Verified}`)
if (reviewError) throw reviewError
