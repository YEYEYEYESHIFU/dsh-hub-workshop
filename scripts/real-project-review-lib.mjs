import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { validateWorkshopManifest } from './workshop-manifest-lib.mjs'

const COMMIT_RE = /^[0-9a-f]{40}$/
const SOURCE_RE = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9a-f]{40})(?:&path:(\/[A-Za-z0-9._/-]+))?$/
const SECRET_RE = /(?:github_pat_|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b)/i
const TEXT_LIMIT = 2 * 1024 * 1024

function safeJoin(root, path = '') {
  const target = resolve(root, path.replace(/^\//, ''))
  const child = relative(resolve(root), target)
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`unsafe repository path: ${path}`)
  return target
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function trackedFiles(root) {
  const files = []
  async function visit(path, prefix = '') {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = join(path, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(absolute, name)
      else files.push({ absolute, name, symlink: entry.isSymbolicLink() })
    }
  }
  await visit(root)
  return files
}

async function scanSource(root) {
  const files = await trackedFiles(root)
  const secretFiles = []
  const nativeFiles = []
  const executableIntentFiles = []
  for (const file of files) {
    if (/\.(?:node|gyp)$/i.test(file.name) || /(?:^|\/)binding\.gyp$/i.test(file.name)) nativeFiles.push(file.name)
    if (!file.symlink && /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sh|zsh|bash|toml|txt)$/i.test(file.name)) {
      const info = await lstat(file.absolute)
      if (info.size > TEXT_LIMIT) continue
      const body = await readFile(file.absolute, 'utf8').catch(() => '')
      if (SECRET_RE.test(body)) secretFiles.push(file.name)
      if (/(?:node:child_process|\bexecFile\s*\(|\bspawn\s*\(|\beval\s*\(|new Function\s*\()/i.test(body)) executableIntentFiles.push(file.name)
    }
  }
  return {
    fileCount: files.length,
    symlinks: files.filter((file) => file.symlink).map((file) => file.name),
    secretFiles,
    nativeFiles,
    executableIntentFiles,
  }
}

function legacySignals(packageJson) {
  const signals = []
  if (packageJson?.dsh?.bundle?.patch) signals.push(`dsh.bundle.patch:${packageJson.dsh.bundle.patch}`)
  if (packageJson?.dsh?.mcpServers) signals.push(`dsh.mcpServers:${packageJson.dsh.mcpServers}`)
  if (Array.isArray(packageJson?.dsh?.skills)) signals.push(...packageJson.dsh.skills.map((path) => `dsh.skills:${path}`))
  return signals
}

function observedType(packageJson) {
  if (packageJson?.dsh?.bundle?.patch) return { protocol: 'harness-profile', adapter: 'profile-bundle', migrations: [] }
  if (packageJson?.dsh?.mcpServers) return {
    protocol: 'harness-repository',
    adapter: 'repository-plugin',
    migrations: ['Declare the legacy package honestly as harness-repository/repository-plugin, or publish a current MCP server.json and migrate to mcp/mcp-server.'],
  }
  if (Array.isArray(packageJson?.dsh?.skills)) return {
    protocol: 'harness-repository',
    adapter: 'repository-plugin',
    migrations: ['Declare the legacy package honestly as harness-repository/repository-plugin, or expose the Skill root directly and migrate to skill/skill.'],
  }
  return { protocol: null, adapter: null, migrations: ['Declare an integration protocol and adapter in package.json#dshWorkshop.'] }
}

function packageArtifact(packageJson) {
  if (packageJson?.dshWorkshop?.integration?.artifact) return packageJson.dshWorkshop.integration.artifact
  return packageJson?.dsh?.bundle?.patch || packageJson?.dsh?.mcpServers || packageJson?.dsh?.skills?.[0] || null
}

function runtimePins(packageJson) {
  const entries = Object.entries({ ...packageJson?.dependencies, ...packageJson?.devDependencies })
  return entries.filter(([name]) => name.startsWith('@deepseek-ai/')).map(([name, version]) => `${name}@${version}`).sort()
}

export function parseLegacySource(value) {
  const match = SOURCE_RE.exec(value || '')
  if (!match) throw new Error(`unsupported fixed source coordinate: ${value}`)
  return {
    repository: `https://github.com/${match[1]}/${match[2]}`,
    ref: match[3],
    path: match[4] || null,
  }
}

export function validateRealProjectReview(review) {
  const errors = []
  const require = (condition, message) => { if (!condition) errors.push(message) }
  require(review?.schema === 'omdsh-workshop-real-project-review/v1', 'unsupported real-project review schema')
  require(/^[a-z0-9][a-z0-9-]*$/.test(review?.id || ''), 'invalid project id')
  require(COMMIT_RE.test(review?.source?.ref || ''), 'fixed commit is required')
  require(review?.source?.publiclyReachable === true, 'source must be anonymously publicly reachable')
  require(Array.isArray(review?.sequence) && review.sequence.map((item) => item.stage).join(',') === 'fixed-source,type-plan,trust-review,adapter,evidence,human-review,admission', 'review stages are missing or out of order')
  require(review?.trustReview?.sourceExecutionAuthorized === false, 'pre-admission review must not authorize source execution')
  require(review?.claims?.rc6Verified === false, 'pre-admission review cannot grant RC.6 verification')
  require(review?.humanReview?.state !== 'approved', 'generated review cannot approve its own independent human review')
  require(review?.admission?.state !== 'admitted', 'generated review cannot admit a project')
  if (review?.typePlan?.state === 'blocked') require(review?.adapter?.state === 'blocked', 'blocked type plan must block the adapter')
  return [...new Set(errors)]
}

export async function inspectRealProject({ candidate, checkoutRoot, observedDefaultHead, tree, reviewedAt }) {
  const source = parseLegacySource(candidate.source)
  if (!COMMIT_RE.test(observedDefaultHead || '') || !COMMIT_RE.test(tree || '')) throw new Error(`${candidate.id}: invalid public Git evidence`)
  const projectRoot = safeJoin(checkoutRoot, source.path || '')
  const packagePath = join(projectRoot, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const scan = await scanSource(projectRoot)
  const manifestErrors = packageJson.dshWorkshop === undefined ? ['package.json#dshWorkshop is absent'] : validateWorkshopManifest(packageJson.dshWorkshop)
  const manifestState = packageJson.dshWorkshop === undefined ? 'absent' : manifestErrors.length ? 'invalid' : 'valid'
  const observed = observedType(packageJson)
  const artifact = packageArtifact(packageJson)
  const artifactPresent = artifact ? await exists(safeJoin(projectRoot, artifact)) : false
  const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter((name) => packageJson.scripts?.[name])
  const licensePresent = await exists(join(checkoutRoot, 'LICENSE')) || await exists(join(projectRoot, 'LICENSE'))
  const versionsMatch = candidate.version === packageJson.version
  const licensesMatch = Boolean(packageJson.license && candidate.license === packageJson.license && licensePresent)
  const pins = runtimePins(packageJson)
  const rc5Pins = pins.filter((pin) => /(?:0\.0\.1|4\.0\.1)-rc\.[45]\b/.test(pin))
  const findings = []
  if (manifestState !== 'valid') findings.push({ severity: 'blocker', code: manifestState === 'absent' ? 'workshop-manifest-absent' : 'workshop-manifest-invalid', evidence: manifestErrors.join('; ') })
  if (!versionsMatch) findings.push({ severity: 'blocker', code: 'catalog-version-mismatch', evidence: `Catalog ${candidate.version}; fixed package.json ${packageJson.version}.` })
  if (!licensesMatch) findings.push({ severity: 'blocker', code: 'license-evidence-mismatch', evidence: `Catalog ${candidate.license}; package.json ${packageJson.license || 'missing'}; LICENSE present=${licensePresent}.` })
  if (!artifactPresent) findings.push({ severity: 'blocker', code: 'integration-artifact-missing', evidence: artifact ? `Declared legacy artifact ${artifact} was not found.` : 'No integration artifact was declared.' })
  if (rc5Pins.length) findings.push({ severity: 'blocker', code: 'legacy-runtime-pins', evidence: `Fixed package still declares ${rc5Pins.join(', ')}; this is not RC.6 evidence.` })
  if (lifecycleScripts.length) findings.push({ severity: 'review', code: 'package-lifecycle-scripts', evidence: `Lifecycle scripts present: ${lifecycleScripts.join(', ')}. They were not executed and must remain disabled until reviewed.` })
  if (scan.symlinks.length) findings.push({ severity: 'review', code: 'symbolic-links-present', evidence: `${scan.symlinks.length} symbolic link(s) require containment review.` })
  if (scan.secretFiles.length) findings.push({ severity: 'blocker', code: 'credential-pattern-detected', evidence: `Credential-like patterns detected in ${scan.secretFiles.length} tracked file(s); values were not copied into evidence.` })
  if (scan.nativeFiles.length) findings.push({ severity: 'review', code: 'native-code-present', evidence: `${scan.nativeFiles.length} native build artifact(s) require platform-specific review.` })
  if (scan.executableIntentFiles.length) findings.push({ severity: 'review', code: 'process-execution-intent', evidence: `${scan.executableIntentFiles.length} tracked file(s) contain process-execution intent and require manual inspection.` })
  if (observed.adapter === 'repository-plugin') findings.push({ severity: 'blocker', code: 'repository-plugin-contract-unavailable', evidence: 'The current public RC.6 baseline does not expose the legacy Repository Plugin contract.' })

  const planReady = manifestState === 'valid' && versionsMatch && licensesMatch && artifactPresent
  const trustState = findings.some((item) => item.severity === 'blocker') ? 'needs-fix' : 'pending-human'
  const declaredProtocol = packageJson.dshWorkshop?.integration?.protocol || null
  const declaredAdapter = packageJson.dshWorkshop?.install?.adapter || null
  const releaseId = `${candidate.id}@${packageJson.version}`
  const reviewPath = `intake/reviews/${releaseId}.json`
  const review = {
    schema: 'omdsh-workshop-real-project-review/v1',
    id: candidate.id,
    releaseId,
    source: {
      repository: source.repository,
      ref: source.ref,
      path: source.path,
      packagePath: source.path ? `${source.path.replace(/^\//, '')}/package.json` : 'package.json',
      publiclyReachable: true,
      observedDefaultHead,
      tree,
    },
    catalog: {
      version: candidate.version,
      license: candidate.license,
      kind: candidate.kind,
      legacyManagement: candidate.mode,
    },
    package: {
      name: String(packageJson.name || ''),
      version: String(packageJson.version || ''),
      license: packageJson.license || null,
      private: packageJson.private === true,
      workshopManifest: manifestState,
      legacySignals: legacySignals(packageJson),
      lifecycleScripts,
    },
    sequence: [
      { stage: 'fixed-source', state: 'passed', reason: `Anonymous public Git fetch resolved the exact commit and tree ${tree}.` },
      { stage: 'type-plan', state: planReady ? 'passed' : 'blocked', reason: planReady ? 'A valid author declaration is available for Harness planning.' : 'A valid author-declared package.json#dshWorkshop and matching release facts are required.' },
      { stage: 'trust-review', state: 'completed', reason: `Assisted static review recorded ${findings.length} finding(s) without executing source code.` },
      { stage: 'adapter', state: planReady && trustState === 'pending-human' ? 'blocked' : 'blocked', reason: 'Source execution requires a separate explicit human trust decision after a valid type plan.' },
      { stage: 'evidence', state: 'saved', reason: `Pre-admission review evidence is stored at ${reviewPath}.` },
      { stage: 'human-review', state: 'pending', reason: 'Independent maintainer review has not been recorded.' },
      { stage: 'admission', state: 'not-created', reason: 'Admission is a separate explicit change after approved review and passing Harness evidence.' },
    ],
    typePlan: {
      state: planReady ? 'ready' : 'blocked',
      declaredProtocol,
      declaredAdapter,
      observedLegacyProtocol: observed.protocol,
      observedLegacyAdapter: observed.adapter,
      migrationOptions: observed.migrations,
      reason: planReady ? 'Author declaration and fixed release facts are sufficient to generate a typed Harness plan.' : manifestErrors.join('; ') || 'Release facts do not match the fixed source.',
    },
    trustReview: {
      state: trustState,
      method: 'assisted-static-public-source-review',
      sourceExecutionAuthorized: false,
      checks: {
        publicCommit: 'passed',
        packageJson: 'passed',
        workshopManifest: manifestState === 'valid' ? 'passed' : 'failed',
        catalogVersion: versionsMatch ? 'passed' : 'failed',
        license: licensesMatch ? 'passed' : 'failed',
        artifact: artifactPresent ? 'passed' : 'failed',
        credentials: scan.secretFiles.length ? 'failed' : 'passed',
        symlinkContainment: scan.symlinks.length ? 'review-required' : 'passed',
        nativeCode: scan.nativeFiles.length ? 'review-required' : 'passed',
        lifecycleScripts: lifecycleScripts.length ? 'review-required' : 'passed',
        processExecutionIntent: scan.executableIntentFiles.length ? 'review-required' : 'passed',
        rc6Baseline: rc5Pins.length ? 'failed' : observed.adapter === 'repository-plugin' ? 'blocked' : 'not-applicable',
      },
      findings,
    },
    adapter: {
      state: 'blocked',
      name: declaredAdapter || observed.adapter,
      reason: planReady ? 'Awaiting a separate explicit human trust decision.' : 'Typed Harness plan is blocked; project code was not executed.',
      report: null,
    },
    humanReview: {
      state: 'pending',
      reviewer: null,
      reason: 'The generated assisted review cannot approve its own independent human gate.',
    },
    admission: {
      state: 'not-created',
      reason: 'No approved human review or passing RC.6 Harness report exists for this fixed release.',
    },
    claims: {
      rc6Verified: false,
      seamlessInstall: 'unknown',
      failureIsolation: 'unknown',
      hotReload: 'unknown',
    },
    reviewedAt,
    reviewer: 'codex-assisted-pre-admission-review',
  }
  const errors = validateRealProjectReview(review)
  if (errors.length) throw new Error(`${candidate.id}: ${errors.join('; ')}`)
  return review
}

export function reviewDigest(review) {
  return createHash('sha256').update(`${JSON.stringify(review)}\n`).digest('hex')
}
