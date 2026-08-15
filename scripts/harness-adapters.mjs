import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { parseDocument } from 'yaml'

import { validateWorkshopManifest, validateOfficialMcpManifest, MCP_PROTOCOL_CURRENT, MCP_REGISTRY_SCHEMA } from './workshop-manifest-lib.mjs'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_SKILL_FILES = 256
const MAX_SKILL_BYTES = 5 * 1024 * 1024
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SECRET_RE = /(?:github_pat_|\bgh[opusr]_[A-Za-z0-9_]{16,}|\bnpm_[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b)/i
const DANGEROUS_COMMAND_RE = /(?:\bcurl\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\bwget\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b|\brm\s+-[^\n]*r[^\n]*f[^\n]*(?:\s\/\s|\s~(?:\/|\s|$)|\$HOME)|\bsudo\b|\bnpm\s+publish\b|\bchmod\s+777\b|\b(?:security|defaults)\s+delete\b)/i

function contained(root, target) {
  const child = relative(resolve(root), resolve(target))
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

function short(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function commandResult(command, args, {
  cwd,
  env,
  timeoutMs = 30_000,
  allowFailure = false,
  stdin = null,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current, chunk) => `${current}${chunk}`.slice(-MAX_OUTPUT_BYTES)
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref()
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      const result = { code: code ?? 1, signal, stdout, stderr }
      if (!allowFailure && code !== 0) {
        const detail = [stderr, stdout].filter((value) => String(value || '').trim()).join('\n')
        rejectPromise(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${short(detail)}`))
      } else {
        resolvePromise(result)
      }
    })
    if (stdin !== null) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function hashTree(root) {
  const digest = createHash('sha256')
  async function visit(path, prefix = '') {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(path, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(absolute)
      digest.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${name}:`)
      if (entry.isDirectory()) await visit(absolute, name)
      else if (entry.isSymbolicLink()) digest.update(await readlink(absolute))
      else if (entry.isFile()) digest.update(await readFile(absolute))
      digest.update(`:${info.mode & 0o777}\n`)
    }
  }
  await visit(root)
  return digest.digest('hex')
}

function sandboxString(value) {
  return JSON.stringify(resolve(value))
}

async function createMacSandbox(workspace, readRoots, { allowLoopback = false } = {}) {
  if (process.platform !== 'darwin' || !await exists('/usr/bin/sandbox-exec')) {
    throw new Error('an enforced deny-network sandbox is unavailable on this platform')
  }
  const readableCandidates = [
    '/System',
    '/usr',
    '/opt',
    '/Library',
    '/private/etc',
    '/private/preboot',
    '/private/var/db/dyld',
    '/private/var/db/timezone',
    '/private/var/folders',
    '/dev',
    workspace,
    ...readRoots,
  ]
  const readable = [...new Set(await Promise.all(readableCandidates.map(async (path) => {
    const absolute = resolve(path)
    return realpath(absolute).catch(() => absolute)
  })))]
  const writableWorkspace = await realpath(workspace)
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow file-read-metadata)',
    `(allow file-read-data (literal "/") ${readable.map((path) => `(subpath ${sandboxString(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${sandboxString(writableWorkspace)}) (literal "/dev/null"))`,
    '(deny network*)',
    ...(allowLoopback ? [
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (remote ip "localhost:*"))',
    ] : []),
  ].join('\n')
  const path = join(workspace, 'harness.sb')
  await writeFile(path, `${profile}\n`, 'utf8')
  const probe = await commandResult('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true'], { cwd: workspace, allowFailure: true })
  if (probe.code !== 0) throw new Error(`sandbox policy failed its self-test: ${short(probe.stderr)}`)
  const writeProbe = join(workspace, '.sandbox-write-probe')
  const insideWrite = await commandResult('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', writeProbe], { cwd: workspace, allowFailure: true })
  if (insideWrite.code !== 0 || !await exists(writeProbe)) throw new Error(`sandbox cannot write inside its workspace: ${short(insideWrite.stderr)}`)
  await rm(writeProbe, { force: true })
  const outsideProbe = join(dirname(writableWorkspace), `.omdsh-sandbox-deny-${createHash('sha256').update(writableWorkspace).digest('hex').slice(0, 12)}`)
  const outsideWrite = await commandResult('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/touch', outsideProbe], { cwd: workspace, allowFailure: true })
  if (outsideWrite.code === 0 || await exists(outsideProbe)) {
    await rm(outsideProbe, { force: true })
    throw new Error('sandbox unexpectedly wrote outside its workspace')
  }
  const socketProbe = allowLoopback ? [
    "const net = require('node:net')",
    'const server = net.createServer((socket) => socket.end())',
    "server.once('error', () => process.exit(2))",
    "server.listen(0, '127.0.0.1', () => {",
    "  const client = net.connect(server.address().port, '127.0.0.1')",
    "  client.once('error', () => process.exit(3))",
    "  client.once('close', () => server.close(() => process.exit(0)))",
    '})',
  ].join('; ') : [
    "const net = require('node:net')",
    'const server = net.createServer()',
    "server.once('error', (error) => process.exit(['EPERM', 'EACCES'].includes(error.code) ? 0 : 2))",
    "server.listen(0, '127.0.0.1', () => process.exit(3))",
  ].join('; ')
  const network = await commandResult('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', socketProbe], { cwd: workspace, allowFailure: true })
  if (network.code !== 0) throw new Error(`sandbox loopback policy self-test failed with exit ${network.code}: ${short(network.stderr)}`)
  const externalProbe = [
    "const dgram = require('node:dgram')",
    "const socket = dgram.createSocket('udp4')",
    'let finished = false',
    "const done = (error) => { if (finished) return; finished = true; socket.close(); process.exit(error && ['EPERM', 'EACCES'].includes(error.code) ? 0 : 3) }",
    'socket.once(\'error\', done)',
    "socket.send(Buffer.from([0]), 53, '1.1.1.1', (error) => {",
    '  done(error)',
    '})',
  ].join('; ')
  const external = await commandResult('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', externalProbe], { cwd: workspace, allowFailure: true })
  if (external.code !== 0) throw new Error(`sandbox external-network denial self-test failed with exit ${external.code}: ${short(external.stderr)}`)
  return { path, profile, selfTest: { insideWrite: true, outsideWriteDenied: true, loopbackAllowed: allowLoopback, externalNetworkDenied: true } }
}

function sandboxed(sandbox, command, args) {
  return { command: '/usr/bin/sandbox-exec', args: ['-p', sandbox.profile, command, ...args] }
}

function childEnvironment(workspace, extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'C.UTF-8',
    TMPDIR: workspace,
    npm_config_userconfig: '/dev/null',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    DSH_TELEMETRY_DISABLED: '1',
    ...extra,
  }
}

function passed(evidence, facts, capability) {
  return { status: 'passed', evidence, facts, ...(capability ? { capability } : {}) }
}

function failed(evidence, facts = {}) {
  return { status: 'failed', evidence, facts }
}

function normalizedGitHubRemote(value) {
  return String(value || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
}

async function sourceFacts({ sourceRoot, sourceCommit, expectedSource, fixtureSource = false }) {
  if (sourceCommit !== expectedSource.ref) return failed('local source is not bound to the plan commit', { sourceImmutable: false })
  if (fixtureSource) {
    const digest = await hashTree(sourceRoot)
    return passed(`maintainer-owned synthetic fixture bound to ${sourceCommit}; tree sha256:${digest}; not valid as community admission evidence`, { sourceImmutable: true })
  }
  const git = async (args, allowFailure = false) => commandResult('git', ['-C', sourceRoot, ...args], {
    env: childEnvironment(tmpdir()),
    allowFailure,
    timeoutMs: 15_000,
  })
  const repository = await git(['rev-parse', '--show-toplevel'], true)
  if (repository.code !== 0) return failed('real Harness source must be a Git checkout', { sourceImmutable: false })
  const repositoryRoot = repository.stdout.trim()
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (head !== sourceCommit) return failed(`Git HEAD ${head} does not match the planned commit`, { sourceImmutable: false })
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
  if (status) return failed(`Git checkout is not clean (${status.split('\n').length} path(s) differ from the fixed commit)`, { sourceImmutable: false })
  const origin = await git(['remote', 'get-url', 'origin'], true)
  if (origin.code !== 0 || normalizedGitHubRemote(origin.stdout) !== normalizedGitHubRemote(expectedSource.repository)) {
    return failed('Git origin does not match the planned public repository', { sourceImmutable: false })
  }
  const expectedRoot = expectedSource.path ? resolve(repositoryRoot, `.${expectedSource.path}`) : repositoryRoot
  const sourceReal = await realpath(sourceRoot)
  const expectedReal = await realpath(expectedRoot).catch(() => null)
  if (!expectedReal || sourceReal !== expectedReal) return failed('local source path does not match the planned repository subpath', { sourceImmutable: false })
  const treeSpec = expectedSource.path ? `HEAD:${expectedSource.path.replace(/^\//, '')}` : 'HEAD^{tree}'
  const tree = (await git(['rev-parse', treeSpec])).stdout.trim()
  return passed(`clean Git origin, HEAD, and source path match ${sourceCommit}; Git tree ${tree}`, { sourceImmutable: true })
}

async function archivedSourceFacts({ sourceRoot, bindingRoot, sourceCommit, expectedSource }) {
  const git = async (args, allowFailure = false) => commandResult('git', ['-C', bindingRoot, ...args], {
    env: childEnvironment(tmpdir()),
    allowFailure,
    timeoutMs: 15_000,
  })
  const repository = await git(['rev-parse', '--show-toplevel'], true)
  if (repository.code !== 0) return failed('archive binding must use a Git checkout', { sourceImmutable: false })
  const status = (await git(['status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
  if (status) return failed(`archive binding checkout is not clean (${status.split('\n').length} path(s) differ)`, { sourceImmutable: false })
  const origin = await git(['remote', 'get-url', 'origin'], true)
  if (origin.code !== 0 || normalizedGitHubRemote(origin.stdout) !== normalizedGitHubRemote(expectedSource.repository)) {
    return failed('archive binding origin does not match the planned public repository', { sourceImmutable: false })
  }
  const resolvedCommit = (await git(['rev-parse', `${sourceCommit}^{commit}`], true)).stdout.trim()
  if (resolvedCommit !== sourceCommit) return failed('archive binding does not contain the planned commit', { sourceImmutable: false })

  const sourcePath = expectedSource.path?.replace(/^\//, '') || ''
  const treeArgs = ['ls-tree', '-rz', '--full-tree', sourceCommit]
  if (sourcePath) treeArgs.push('--', sourcePath)
  const treeResult = await git(treeArgs)
  const expected = new Map()
  for (const record of treeResult.stdout.split('\0').filter(Boolean)) {
    const match = /^([0-9]+) ([^ ]+) ([0-9a-f]+)\t(.+)$/.exec(record)
    if (!match || match[2] !== 'blob') return failed(`unsupported Git tree entry in archived source: ${short(record)}`, { sourceImmutable: false })
    const name = sourcePath ? match[4].replace(new RegExp(`^${sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '') : match[4]
    if (name) expected.set(name, { mode: match[1], object: match[3] })
  }

  const actual = new Map()
  async function visit(path, prefix = '') {
    const entries = await readdir(path, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const absolute = join(path, entry.name)
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await visit(absolute, name)
        continue
      }
      const info = await lstat(absolute)
      const body = entry.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute)
      const object = createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex')
      const mode = entry.isSymbolicLink() ? '120000' : (info.mode & 0o111) ? '100755' : '100644'
      actual.set(name, { mode, object })
    }
  }
  await visit(sourceRoot)
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort()
  const mismatch = paths.find((path) => expected.get(path)?.mode !== actual.get(path)?.mode
    || expected.get(path)?.object !== actual.get(path)?.object)
  if (mismatch) {
    return failed(`archived source differs from ${sourceCommit} at ${mismatch}`, { sourceImmutable: false })
  }
  const tree = (await git(['rev-parse', sourcePath ? `${sourceCommit}:${sourcePath}` : `${sourceCommit}^{tree}`])).stdout.trim()
  return passed(`clean public Git binding contains ${sourceCommit}; extracted ${expected.size}-file archive matches tree ${tree}`, { sourceImmutable: true })
}

async function commonAdapterStep(item, context) {
  const { sourceRoot, sourceCommit, plan, packageJson, artifactPath, fixtureSource } = context
  if (item.id === 'source.immutable') return sourceFacts({ sourceRoot, sourceCommit, expectedSource: plan.source, fixtureSource })
  if (item.id === 'manifest.validate') {
    const errors = validateWorkshopManifest(packageJson?.dshWorkshop)
    return errors.length === 0
      ? passed('package.json#dshWorkshop passed the public manifest contract', { manifestValid: true })
      : failed(errors.join('; '), { manifestValid: false })
  }
  if (item.id === 'artifact.present') {
    const present = await exists(artifactPath)
    return present ? passed(`artifact present at ${artifactPath}`, { artifactPresent: true }) : failed(`artifact missing at ${artifactPath}`, { artifactPresent: false })
  }
  if (item.id === 'compatibility.baseline') {
    const compatible = plan.baseline.package === '@deepseek-ai/dsh' && plan.baseline.version === '0.1.0-rc.6'
    return compatible ? passed('adapter is pinned to @deepseek-ai/dsh@0.1.0-rc.6', { compatibilityPassed: true }) : failed('adapter baseline is not RC.6', { compatibilityPassed: false })
  }
  if (item.id === 'permissions.review') {
    const permissions = packageJson?.dshWorkshop?.permissions || []
    return SECRET_RE.test(JSON.stringify(permissions))
      ? failed('permission declarations appear to contain a credential', { permissionsReviewed: false })
      : passed(`reviewed ${permissions.length} declared permission scope(s)`, { permissionsReviewed: true })
  }
  if (item.id === 'supply-chain.review') {
    const scripts = packageJson?.scripts || {}
    const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepare'].filter((name) => scripts[name])
    return lifecycleScripts.length === 0
      ? passed('no package lifecycle scripts; installation is forced to ignore scripts', { supplyChainPassed: true, installScriptsDisabled: true })
      : failed(`package lifecycle scripts require manual review: ${lifecycleScripts.join(', ')}`, { supplyChainPassed: false, installScriptsDisabled: true })
  }
  return null
}

async function waitForFile(path, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await exists(path)) return readJson(path)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitForOutput(read, pattern, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const match = pattern.exec(read())
    if (match) return match
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60))
  }
  throw new Error(`timed out waiting for process output ${pattern}`)
}

function spawnTracked(command, args, options) {
  const child = spawn(command, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-MAX_OUTPUT_BYTES) })
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES) })
  return { child, get stdout() { return stdout }, get stderr() { return stderr } }
}

async function stopTracked(tracked, timeoutMs = 7_000, signalPid = tracked?.child.pid) {
  if (!tracked || tracked.child.exitCode !== null || tracked.child.signalCode !== null) return
  try {
    process.kill(signalPid, 'SIGTERM')
  } catch {
    tracked.child.kill('SIGTERM')
  }
  const exited = new Promise((resolvePromise) => tracked.child.once('exit', resolvePromise))
  const timeout = new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs, 'timeout'))
  if (await Promise.race([exited, timeout]) === 'timeout') {
    try {
      process.kill(signalPid, 'SIGKILL')
    } catch {}
    tracked.child.kill('SIGKILL')
    await new Promise((resolvePromise) => tracked.child.once('exit', resolvePromise))
  }
}

export async function createRc6ProfileAdapter({
  plan,
  sourceRoot,
  previousSourceRoot,
  previousSourceBindingRoot = null,
  sourceCommit = plan.source.ref,
  previousSourceCommit = plan.updateFrom?.ref,
  fixtureSource = false,
  keepWorkspace = false,
  runtimeBlockReason = null,
  pnpmStoreRoot = null,
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'omdsh-profile-harness-'))
  const runtimeRoot = join(workspace, 'runtime')
  const dshHome = join(workspace, 'dsh-home')
  const profilesRoot = join(dshHome, 'profiles')
  const probeRoot = join(workspace, 'probe')
  const packageRoot = join(workspace, 'packages')
  const pnpmStore = pnpmStoreRoot ? resolve(pnpmStoreRoot) : join(workspace, 'pnpm-store')
  await mkdir(runtimeRoot, { recursive: true })
  await mkdir(probeRoot, { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  if (!plan.updateFrom || !previousSourceRoot || !previousSourceCommit) throw new Error('Profile update test requires a fixed previous release checkout')
  const packageJson = await readJson(join(sourceRoot, 'package.json'))
  const previousPackageJson = await readJson(join(previousSourceRoot, 'package.json'))
  const sourceDependencyNames = Object.keys(packageJson.dependencies || {}).sort()
  const sourceLock = sourceDependencyNames.length > 0
    ? parseDocument(await readFile(join(sourceRoot, 'pnpm-lock.yaml'), 'utf8')).toJS()
    : null
  const sourceRuntimeDependencies = sourceDependencyNames.map((name) => {
    const locked = sourceLock?.importers?.['.']?.dependencies?.[name]?.version
    const version = String(locked || '').replace(/\(.+$/, '')
    const integrity = sourceLock?.packages?.[`${name}@${version}`]?.resolution?.integrity
    if (!version || !integrity) throw new Error(`Profile source dependency ${name} lacks an exact pnpm-lock.yaml binding`)
    return { name, version, integrity }
  })
  const capability = packageJson.dshWorkshop?.capability
  if (!capability) throw new Error('Profile adapter requires package.json#dshWorkshop.capability')
  const configNeedle = packageJson.name
  const artifactPath = join(sourceRoot, packageJson.dsh?.bundle?.patch || '')
  const profileBase = plan.profileBase
  if (!profileBase) throw new Error('Profile adapter requires a fixed plan.profileBase')
  const sandbox = await createMacSandbox(workspace, [sourceRoot, previousSourceRoot, pnpmStore], { allowLoopback: profileBase.template === 'web' })
  const state = {
    runtimeBin: null,
    currentHash: null,
    candidateHash: null,
    profileProcess: null,
    lastReady: null,
    disposed: null,
    hotReloadPid: null,
    hotDisposed: null,
    hotReady: null,
    lastStop: null,
    webUrl: null,
    currentSentinel: join(workspace, 'current-protection.json'),
  }
  await writeJson(state.currentSentinel, { state: 'protected', createdAt: 'fixture' })
  const sentinelHash = createHash('sha256').update(await readFile(state.currentSentinel)).digest('hex')

  const runDsh = async (args, { allowFailure = false, timeoutMs = 60_000 } = {}) => {
    if (!state.runtimeBin) throw new Error('RC.6 runtime is not installed')
    const wrapped = sandboxed(sandbox, process.execPath, [state.runtimeBin, ...args])
    return commandResult(wrapped.command, wrapped.args, {
      cwd: workspace,
      env: childEnvironment(workspace, {
        DSH_HOME: dshHome,
        OMDSH_HARNESS_PROBE_DIR: probeRoot,
        npm_config_ignore_scripts: 'true',
        NPM_CONFIG_IGNORE_SCRIPTS: 'true',
        npm_config_offline: 'true',
        NPM_CONFIG_OFFLINE: 'true',
        npm_config_store_dir: pnpmStore,
        NPM_CONFIG_STORE_DIR: pnpmStore,
      }),
      allowFailure,
      timeoutMs,
    })
  }
  const pnpmArgs = (command, ...args) => [command, ...args, '--offline', '--ignore-scripts', '--store-dir', pnpmStore]
  const initProfile = async (name) => {
    await runDsh(['plugin', '--profile', name, 'list', '--depth', '-1'])
    const manifestPath = join(profilesRoot, name, 'package.json')
    const manifest = await readJson(manifestPath)
    manifest.dsh.profile.bundles = [...profileBase.bundles]
    if (sourceRuntimeDependencies.length > 0) {
      manifest.pnpm = {
        ...(manifest.pnpm || {}),
        overrides: {
          ...(manifest.pnpm?.overrides || {}),
          ...Object.fromEntries(sourceRuntimeDependencies.map(({ name }) => [name, `link:${join(runtimeRoot, 'node_modules', ...name.split('/'))}`])),
        },
      }
    }
    await writeJson(manifestPath, manifest)
  }
  const packedBundles = new Map()
  const packageBundle = async (root) => {
    if (packedBundles.has(root)) return packedBundles.get(root)
    const packed = await commandResult('npm', [
      'pack',
      root,
      '--pack-destination',
      packageRoot,
      '--ignore-scripts',
      '--json',
      '--userconfig=/dev/null',
    ], {
      cwd: workspace,
      env: childEnvironment(workspace, { npm_config_ignore_scripts: 'true', NPM_CONFIG_IGNORE_SCRIPTS: 'true' }),
      timeoutMs: 60_000,
    })
    const metadata = JSON.parse(packed.stdout)
    if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0]?.filename || !metadata[0]?.integrity) {
      throw new Error(`npm pack did not return one integrity-bound artifact for ${root}`)
    }
    const artifact = join(packageRoot, metadata[0].filename)
    packedBundles.set(root, artifact)
    return artifact
  }
  const installBundle = async (name, root) => runDsh(['plugin', '--profile', name, ...pnpmArgs('add', await packageBundle(root))], { timeoutMs: 90_000 })
  const dumpProfile = async (name, allowFailure = false) => runDsh(['--profile', name, '--dump-config'], { allowFailure })
  const profileDir = (name) => join(profilesRoot, name)
  const clearProbe = async () => {
    for (const name of ['ready.json', 'disposed.json']) await rm(join(probeRoot, name), { force: true })
  }
  const startProfile = async (name) => {
    await clearProbe()
    const appArgs = profileBase.template === 'web' ? ['--host', '127.0.0.1', '--port', '0'] : []
    const wrapped = sandboxed(sandbox, process.execPath, [state.runtimeBin, '--profile', name, ...appArgs])
    const tracked = spawnTracked(wrapped.command, wrapped.args, {
      cwd: workspace,
      env: childEnvironment(workspace, { DSH_HOME: dshHome, OMDSH_HARNESS_PROBE_DIR: probeRoot }),
    })
    tracked.child.once('exit', () => {})
    state.profileProcess = tracked
    try {
      state.lastReady = await waitForFile(join(probeRoot, 'ready.json'))
      if (profileBase.template === 'web') {
        const match = await waitForOutput(() => tracked.stdout, /dsh web:\s+(http:\/\/[^\s]+)/)
        const url = new URL(match[1])
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`Web Profile printed a non-loopback URL: ${url}`)
        state.webUrl = url.toString().replace(/\/$/, '')
      }
    } catch (error) {
      throw new Error(`${error.message}; profile wrapper pid=${tracked.child.pid}; exit=${tracked.child.exitCode ?? tracked.child.signalCode ?? 'running'}; stderr=${short(tracked.stderr)}; stdout=${short(tracked.stdout)}`)
    }
    return tracked
  }
  const stopProfile = async () => {
    const tracked = state.profileProcess
    const readyPid = state.lastReady?.pid
    await stopTracked(tracked, 7_000, readyPid)
    state.profileProcess = null
    state.disposed = await waitForFile(join(probeRoot, 'disposed.json'), 2_000).catch(() => null)
    state.lastStop = {
      wrapperPid: tracked?.child.pid ?? null,
      readyPid: readyPid ?? null,
      exitCode: tracked?.child.exitCode ?? null,
      signalCode: tracked?.child.signalCode ?? null,
      disposed: state.disposed,
      stderr: short(tracked?.stderr),
    }
  }

  return {
    name: 'rc6-profile-generation-adapter',
    trustedSourceExecution: true,
    workspace,
    async run(item) {
      const common = await commonAdapterStep(item, { sourceRoot, sourceCommit, plan, packageJson, artifactPath, fixtureSource })
      if (common) return common
      if (item.id === 'update-source.immutable') {
        const source = previousSourceBindingRoot
          ? await archivedSourceFacts({
              sourceRoot: previousSourceRoot,
              bindingRoot: previousSourceBindingRoot,
              sourceCommit: previousSourceCommit,
              expectedSource: plan.updateFrom,
            })
          : await sourceFacts({
              sourceRoot: previousSourceRoot,
              sourceCommit: previousSourceCommit,
              expectedSource: plan.updateFrom,
              fixtureSource,
            })
        const versionMatched = previousPackageJson.name === packageJson.name
          && previousPackageJson.version === plan.updateFrom.version
          && previousPackageJson.version !== packageJson.version
        return source.status === 'passed' && versionMatched
          ? passed(`${source.evidence}; ${previousPackageJson.name}@${previousPackageJson.version} is the fixed update origin`, { sourceImmutable: true, previousVersionMatched: true })
          : failed(`${source.evidence}; previous package identity/version does not match the plan`, { sourceImmutable: source.facts?.sourceImmutable === true, previousVersionMatched: false })
      }
      if (item.id === 'protocol.contract') {
        const patch = packageJson.dsh?.bundle?.patch
        return patch && contained(sourceRoot, artifactPath) && await exists(artifactPath)
          ? passed(`RC.6 dsh.bundle.patch resolves to ${patch}`, { protocolContractValid: true })
          : failed('Profile Bundle patch contract is invalid', { protocolContractValid: false })
      }
      if (item.id === 'sandbox.policy') {
        return passed(`macOS sandbox-exec denies external network and writes outside the ephemeral workspace${profileBase.template === 'web' ? '; loopback-only HTTP is allowed for the Web capability probe' : ''}`, {
          workspaceEphemeral: true,
          networkDeniedByDefault: true,
          installScriptsDisabled: true,
          currentProtected: true,
        })
      }
      if (item.id === 'runtime.exact') {
        await writeJson(join(runtimeRoot, 'package.json'), { private: true })
        await commandResult('npm', [
          'install',
          `${plan.baseline.package}@${plan.baseline.version}`,
          ...sourceRuntimeDependencies.map(({ name, version }) => `${name}@${version}`),
          '--save-exact',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--prefer-offline',
          '--userconfig=/dev/null',
        ], {
          cwd: runtimeRoot,
          env: childEnvironment(workspace),
          timeoutMs: 180_000,
        })
        const installed = await readJson(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
        const lock = await readJson(join(runtimeRoot, 'package-lock.json'))
        const integrity = lock.packages?.['node_modules/@deepseek-ai/dsh']?.integrity
        if (installed.version !== plan.baseline.version || integrity !== plan.baseline.integrity) {
          return failed(`installed runtime binding mismatch: ${installed.version} ${integrity}`, { runtimeExact: false })
        }
        for (const binding of profileBase.exactPackages) {
          const packagePath = join(runtimeRoot, 'node_modules', ...binding.package.split('/'), 'package.json')
          const basePackage = await readJson(packagePath)
          const baseIntegrity = lock.packages?.[`node_modules/${binding.package}`]?.integrity
          if (basePackage.version !== binding.version || baseIntegrity !== binding.integrity) {
            return failed(`installed Profile base binding mismatch: ${binding.package}@${basePackage.version} ${baseIntegrity}`, { runtimeExact: true, profileBaseExact: false })
          }
        }
        for (const binding of sourceRuntimeDependencies) {
          const dependencyPath = join(runtimeRoot, 'node_modules', ...binding.name.split('/'), 'package.json')
          const dependencyPackage = await readJson(dependencyPath)
          const dependencyIntegrity = lock.packages?.[`node_modules/${binding.name}`]?.integrity
          if (dependencyPackage.version !== binding.version || dependencyIntegrity !== binding.integrity) {
            return failed(`installed source dependency binding mismatch: ${binding.name}@${dependencyPackage.version} ${dependencyIntegrity}`, { runtimeExact: true, profileBaseExact: false })
          }
        }
        state.runtimeBin = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        const sourceDependencyEvidence = sourceRuntimeDependencies.length > 0
          ? `; prebound source runtime dependencies ${sourceRuntimeDependencies.map(({ name, version }) => `${name}@${version}`).join(', ')}`
          : ''
        return passed(`installed exact ${plan.baseline.package}@${installed.version} and ${profileBase.template} Profile base with matching sha512 integrities${sourceDependencyEvidence}`, { runtimeExact: true, profileBaseExact: true })
      }
      if (item.id === 'candidate.create') {
        await initProfile('current')
        await installBundle('current', sourceRoot)
        state.currentHash = await hashTree(profileDir('current'))
        await initProfile('candidate')
        const unchanged = state.currentHash === await hashTree(profileDir('current'))
        return unchanged
          ? passed(`RC.6 initialized a separate candidate on ${profileBase.bundles.join(' + ')} while current remained byte-identical`, { candidateCreated: true, currentUntouched: true, profileBaseBound: true })
          : failed('candidate initialization changed current', { candidateCreated: true, currentUntouched: false, profileBaseBound: true })
      }
      if (item.id === 'install.scripts-disabled') {
        const scripts = packageJson.scripts || {}
        const clean = !['preinstall', 'install', 'postinstall', 'prepare'].some((name) => scripts[name])
        return clean ? passed('fixture has no lifecycle scripts and pnpm is forced offline with --ignore-scripts', { installScriptsDisabled: true }) : failed('bundle declares lifecycle scripts', { installScriptsDisabled: false })
      }
      if (item.id === 'install.apply') {
        await installBundle('candidate', sourceRoot)
        const dump = await dumpProfile('candidate')
        const unchanged = state.currentHash === await hashTree(profileDir('current'))
        const installed = dump.stdout.includes(configNeedle) && unchanged
        state.candidateHash = await hashTree(profileDir('candidate'))
        return installed
          ? passed('RC.6 pnpm forwarder installed the fixed bundle and --dump-config resolved its patch', { installed: true, currentUntouched: true })
          : failed(`candidate dump did not contain the probe or current changed: ${short(dump.stderr || dump.stdout)}`, { installed: false, currentUntouched: unchanged })
      }
      if (item.id === 'ready.probe') {
        if (runtimeBlockReason) {
          return { status: 'blocked', evidence: runtimeBlockReason, facts: {} }
        }
        await startProfile('candidate')
        return state.lastReady?.version === packageJson.version && state.lastReady?.capability === capability.id
          ? passed(`RC.6 booted the candidate and ${capability.id} became ready in pid ${state.lastReady.pid}`, { ready: true })
          : failed('candidate process did not produce the expected ready marker', { ready: false })
      }
      if (item.id === 'capability.invoke') {
        const observed = state.lastReady?.capability
        let invocationEvidence = ''
        if (capability.id === '7d7d-routes-registered') {
          if (!state.webUrl) return failed('the live Web Profile did not publish a loopback URL', { capabilityObserved: false })
          const response = await fetch(`${state.webUrl}/7d7d/api/manifest.json`, { signal: AbortSignal.timeout(5_000) })
          const body = await response.json()
          if (!response.ok || body?.games === undefined || body?.categories === undefined) {
            return failed(`the live 7d7d manifest route returned HTTP ${response.status} without the expected manifest`, { capabilityObserved: false })
          }
          invocationEvidence = `; GET /7d7d/api/manifest.json returned HTTP ${response.status} with ${body.games.length} game(s)`
        }
        return observed === capability.id
          ? passed(`the live RC.6 Profile registered, invoked, and observed ${capability.id}${invocationEvidence}`, { capabilityObserved: true }, {
              id: capability.id,
              kind: capability.kind,
              invocation: capability.invocation,
              expected: capability.expected,
              observed,
            })
          : failed('the live Profile capability was not observed', { capabilityObserved: false })
      }
      if (item.id === 'failure.inject-candidate') {
        await initProfile('failure-candidate')
        await writeFile(join(profileDir('failure-candidate'), 'cordis.patch.yml'), '- insert: [\n', 'utf8')
        const result = await dumpProfile('failure-candidate', true)
        return result.code !== 0 ? passed(`malformed candidate failed closed with exit ${result.code}`, { failureInjected: true }) : failed('malformed candidate unexpectedly passed', { failureInjected: false })
      }
      if (item.id === 'failure.current-unchanged') {
        const currentUnchanged = state.currentHash === await hashTree(profileDir('current'))
          && sentinelHash === createHash('sha256').update(await readFile(state.currentSentinel)).digest('hex')
        return currentUnchanged ? passed('failed candidate left current Profile and protected sentinel unchanged', { currentUnchanged: true }) : failed('failed candidate changed protected current state', { currentUnchanged: false })
      }
      if (item.id === 'failure.discard-candidate') {
        await rm(profileDir('failure-candidate'), { recursive: true, force: true })
        return passed('failed candidate directory was discarded', { candidateDiscarded: true })
      }
      if (item.id === 'activation.switch') {
        await stopProfile()
        await rename(profileDir('current'), profileDir('previous'))
        await rename(profileDir('candidate'), profileDir('current'))
        const activated = state.candidateHash === await hashTree(profileDir('current'))
        return activated && await exists(profileDir('previous'))
          ? passed('candidate became current and the former current was retained as previous', { activated: true, previousRetained: true })
          : failed('generation switch did not preserve the expected directories', { activated, previousRetained: await exists(profileDir('previous')) })
      }
      if (item.id === 'lifecycle.restart') {
        await startProfile('current')
        const restarted = state.lastReady?.capability === capability.id
        return restarted
          ? passed(`RC.6 restarted the current Profile and observed ${capability.id} in pid ${state.lastReady.pid}`, { restarted: true, restartScope: 'profile', capabilityObserved: true })
          : failed(`restarted Profile did not expose ${capability.id}`, { restarted: false, restartScope: 'profile', capabilityObserved: false })
      }
      if (item.id === 'lifecycle.dispose') {
        if (state.disposed?.pid !== state.lastReady?.pid) return failed(`RC.6 generation switch did not gracefully dispose the former candidate process: ${short(JSON.stringify(state.lastStop))}`, { disposed: false })
        await startProfile('current')
        state.hotReloadPid = state.lastReady?.pid
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
        await clearProbe()
        await writeFile(join(profileDir('current'), 'cordis.patch.yml'), '- id: harness-profile-probe\n  config:\n    marker: hot-reactivated\n', 'utf8')
        state.hotDisposed = await waitForFile(join(probeRoot, 'disposed.json'))
        state.hotReady = await waitForFile(join(probeRoot, 'ready.json'))
        const disposed = state.hotDisposed?.pid === state.hotReloadPid
        return disposed
          ? passed(`RC.6 live patch disposed the prior Cordis activation without replacing process ${state.hotReloadPid}`, { disposed: true })
          : failed('Cordis live patch did not dispose the prior activation', { disposed: false })
      }
      if (item.id === 'lifecycle.reactivate') {
        const reactivated = state.hotReady?.capability === 'profile-probe'
          && state.hotReady?.marker === 'hot-reactivated'
          && state.hotReady?.pid === state.hotReloadPid
        return reactivated
          ? passed(`RC.6 reactivated the updated Cordis entry inside the same pid ${state.hotReady.pid}`, { reactivated: true, capabilityObserved: true })
          : failed('hot-reactivated Profile did not expose the capability in the same process', { reactivated: false, capabilityObserved: false })
      }
      if (item.id === 'update.apply') {
        await stopProfile()
        const protectedCurrentHash = await hashTree(profileDir('current'))
        await initProfile('candidate-update')
        await installBundle('candidate-update', previousSourceRoot)
        const previousInstalled = await readJson(join(profileDir('candidate-update'), 'node_modules', ...previousPackageJson.name.split('/'), 'package.json'))
        await installBundle('candidate-update', sourceRoot)
        const installed = await readJson(join(profileDir('candidate-update'), 'node_modules', ...packageJson.name.split('/'), 'package.json'))
        const dump = await dumpProfile('candidate-update')
        const currentUnchanged = protectedCurrentHash === await hashTree(profileDir('current'))
        const updatePassed = previousInstalled.version === plan.updateFrom.version
          && installed.version === packageJson.version
          && dump.stdout.includes(packageJson.name)
          && currentUnchanged
        return updatePassed
          ? passed(`RC.6 upgraded an isolated candidate from ${previousInstalled.version} to target ${installed.version} while current remained unchanged`, { updatePassed: true })
          : failed('candidate update did not bind the fixed previous and target releases without touching current', { updatePassed: false })
      }
      if (item.id === 'disable.apply') {
        const manifestPath = join(profileDir('candidate-update'), 'package.json')
        const manifest = await readJson(manifestPath)
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== packageJson.name)
        await writeJson(manifestPath, manifest)
        const dump = await dumpProfile('candidate-update')
        const disablePassed = !dump.stdout.includes(configNeedle)
        return disablePassed ? passed('removing the bundle from dsh.profile.bundles disabled its patch while retaining the dependency', { disablePassed: true }) : failed('disabled bundle remained in composed config', { disablePassed: false })
      }
      if (item.id === 'remove.apply') {
        await runDsh(['plugin', '--profile', 'candidate-update', 'remove', packageJson.name], { timeoutMs: 90_000 })
        const manifest = await readJson(join(profileDir('candidate-update'), 'package.json'))
        const removed = !manifest.dependencies?.[packageJson.name] && !manifest.dsh.profile.bundles.includes(packageJson.name)
        return removed ? passed('RC.6 plugin forwarder removed the dependency and reconciled the bundle list', { removePassed: true }) : failed('removed bundle still appears in the Profile manifest', { removePassed: false })
      }
      if (item.id === 'recovery.generation') {
        await rename(profileDir('current'), profileDir('discarded-current'))
        await rename(profileDir('previous'), profileDir('current'))
        const restored = state.currentHash === await hashTree(profileDir('current'))
        return restored ? passed('previous generation was restored byte-for-byte as current', { recoveryPassed: true, previousRestored: true }) : failed('restored generation does not match the original current Profile', { recoveryPassed: false, previousRestored: false })
      }
      return failed(`RC.6 Profile adapter does not implement ${item.id}`)
    },
    async cleanup() {
      await stopProfile().catch(() => {})
      if (!keepWorkspace) await rm(workspace, { recursive: true, force: true })
      return {
        status: keepWorkspace ? 'failed' : 'passed',
        evidence: keepWorkspace ? `workspace retained by request at ${workspace}` : 'RC.6 Profile workspace and every generation were removed',
        facts: { workspaceRemoved: !keepWorkspace },
      }
    },
  }
}

function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function createMcpProcessAdapter({
  plan,
  sourceRoot,
  sourceCommit = plan.source.ref,
  fixtureSource = false,
  command = process.execPath,
  args = [join(sourceRoot, 'server.mjs')],
  toolName,
  toolArguments = {},
  failureToolName = 'harness-fail',
  keepWorkspace = false,
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'omdsh-mcp-harness-'))
  const packageJson = await readJson(join(sourceRoot, 'package.json'))
  const capability = packageJson.dshWorkshop?.capability
  if (!capability) throw new Error('MCP adapter requires package.json#dshWorkshop.capability')
  const effectiveToolName = toolName || capability.id
  if (effectiveToolName !== capability.id) throw new Error('MCP adapter toolName must match the fixed capability declaration')
  const artifactPath = join(sourceRoot, packageJson.dshWorkshop.integration.artifact)
  const serverManifest = await readJson(artifactPath)
  const sandbox = await createMacSandbox(workspace, [sourceRoot, resolve(sourceRoot, '..', '..', '..')])
  const protectedPath = join(workspace, 'current-profile.json')
  const dataRoot = join(workspace, 'data')
  await mkdir(dataRoot, { recursive: true })
  await writeJson(protectedPath, { state: 'protected' })
  const protectedHash = createHash('sha256').update(await readFile(protectedPath)).digest('hex')
  const state = { client: null, transport: null, pid: null, tools: [], result: null, stderr: '' }

  const start = async () => {
    if (state.client || state.transport || processAlive(state.pid)) throw new Error('an MCP process is already active')
    state.stderr = ''
    const wrapped = sandboxed(sandbox, command, args)
    const transport = new StdioClientTransport({
      command: wrapped.command,
      args: wrapped.args,
      cwd: workspace,
      env: childEnvironment(workspace, { OMDSH_MCP_HARNESS: '1', OMDSH_MCP_DATA_DIR: dataRoot }),
      stderr: 'pipe',
    })
    transport.stderr?.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-MAX_OUTPUT_BYTES) })
    const client = new Client({ name: 'omdsh-workshop-harness', version: '1.0.0' }, {
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_CURRENT } },
    })
    try {
      await client.connect(transport)
    } catch (error) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
      await transport.close().catch(() => {})
      throw new Error(`${error.message}${state.stderr ? `; child stderr: ${short(state.stderr)}` : ''}`)
    }
    state.client = client
    state.transport = transport
    state.pid = transport.pid
    return { client, transport }
  }
  const close = async () => {
    const pid = state.pid
    if (state.client) {
      await state.client.close().catch(async () => {
        if (state.transport) await state.transport.close().catch(() => {})
      })
    } else if (state.transport) {
      await state.transport.close().catch(() => {})
    }
    state.client = null
    state.transport = null
    state.pid = null
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
    return !processAlive(pid)
  }

  return {
    name: 'mcp-2026-stdio-isolated-process-adapter',
    trustedSourceExecution: true,
    workspace,
    async run(item) {
      const common = await commonAdapterStep(item, { sourceRoot, sourceCommit, plan, packageJson, artifactPath, fixtureSource })
      if (common) return common
      if (item.id === 'protocol.contract' || item.id === 'mcp.server-manifest') {
        const errors = validateOfficialMcpManifest({ packageJson, serverManifest, declaration: packageJson.dshWorkshop })
        if (errors.length > 0) return failed(errors.join('; '), item.id === 'protocol.contract' ? { protocolContractValid: false } : { registrySchema: MCP_REGISTRY_SCHEMA, serverManifestValid: false })
        return item.id === 'protocol.contract'
          ? passed('server.json and package ownership conform to the official MCP Registry contract', { protocolContractValid: true })
          : passed('official server.json contract passed at the fixed source', { registrySchema: MCP_REGISTRY_SCHEMA, serverManifestValid: true })
      }
      if (item.id === 'mcp.ownership') return passed(`package.json#mcpName matches ${serverManifest.name}`, { packageOwnershipBound: true })
      if (item.id === 'sandbox.policy') {
        return passed('MCP server will run with deny-network sandboxing, an explicit environment, and workspace-only writes', {
          workspaceEphemeral: true,
          networkDeniedByDefault: true,
          installScriptsDisabled: true,
          currentProtected: true,
        })
      }
      if (item.id === 'mcp.process-create') {
        await start()
        const isolated = processAlive(state.pid)
        return isolated ? passed(`spawned sandboxed MCP stdio pid ${state.pid}`, { processIsolated: true, currentUntouched: true }) : failed(`MCP child failed to stay alive: ${short(state.stderr)}`, { processIsolated: false, currentUntouched: true })
      }
      if (item.id === 'mcp.discover') {
        const era = state.client?.getProtocolEra()
        const discover = state.client?.getDiscoverResult()
        return era === 'modern' && discover
          ? passed('server/discover selected the stateless 2026-07-28 protocol era', { protocolVersion: MCP_PROTOCOL_CURRENT, discovered: true, stateless: true })
          : failed(`MCP modern discovery failed; era=${era}`, { protocolVersion: String(era || 'unknown'), discovered: false, stateless: false })
      }
      if (item.id === 'mcp.tools-list') {
        const listed = await state.client.listTools()
        state.tools = listed.tools || []
        const found = state.tools.some((tool) => tool.name === effectiveToolName)
        return found ? passed(`tools/list returned ${state.tools.length} tool(s), including ${effectiveToolName}`, { toolsListed: true }) : failed(`tools/list did not expose ${effectiveToolName}`, { toolsListed: false })
      }
      if (item.id === 'capability.invoke') {
        state.result = await state.client.callTool({ name: effectiveToolName, arguments: structuredClone(toolArguments) })
        const observed = state.result?.content?.find((item) => item.type === 'text')?.text
        return observed === capability.expected
          ? passed('tools/call returned the expected isolated fixture result', { capabilityObserved: true }, {
              id: capability.id,
              kind: capability.kind,
              invocation: capability.invocation,
              expected: capability.expected,
              observed,
            })
          : failed(`unexpected MCP tool result: ${short(JSON.stringify(state.result))}`, { capabilityObserved: false })
      }
      if (item.id === 'failure.inject-process') {
        let failedClosed = false
        try {
          await state.client.callTool({ name: failureToolName, arguments: {} })
        } catch {
          failedClosed = true
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
        failedClosed = failedClosed && !processAlive(state.pid)
        return failedClosed ? passed('failure tool terminated only the isolated MCP child and the client observed a closed transport', { failureInjected: true }) : failed('MCP failure injection did not terminate the isolated child', { failureInjected: false })
      }
      if (item.id === 'failure.current-unchanged') {
        const currentUnchanged = protectedHash === createHash('sha256').update(await readFile(protectedPath)).digest('hex')
        return currentUnchanged ? passed('MCP process failure left the protected current Profile sentinel unchanged', { currentUnchanged: true }) : failed('MCP process changed the protected sentinel', { currentUnchanged: false })
      }
      if (item.id === 'failure.discard-process') {
        const removed = await close()
        return removed ? passed('failed MCP process was fully reaped', { processDiscarded: true }) : failed('failed MCP process remains alive', { processDiscarded: false })
      }
      if (item.id === 'lifecycle.dispose') return passed('the failed stdio process was disposed before reactivation', { disposed: true })
      if (item.id === 'lifecycle.reactivate') {
        await start()
        const listed = await state.client.listTools()
        const result = await state.client.callTool({ name: effectiveToolName, arguments: structuredClone(toolArguments) })
        const observed = result?.content?.find((entry) => entry.type === 'text')?.text
        const reactivated = listed.tools.some((tool) => tool.name === effectiveToolName) && observed === capability.expected
        return reactivated ? passed(`fresh isolated pid ${state.pid} rediscovered and invoked ${effectiveToolName}`, { reactivated: true, capabilityObserved: true }) : failed('reactivated MCP process did not expose the tool', { reactivated: false, capabilityObserved: false })
      }
      if (item.id === 'lifecycle.restart') {
        await start()
        const listed = await state.client.listTools()
        const result = await state.client.callTool({ name: effectiveToolName, arguments: structuredClone(toolArguments) })
        const observed = result?.content?.find((entry) => entry.type === 'text')?.text
        const restarted = listed.tools.some((tool) => tool.name === effectiveToolName) && observed === capability.expected
        return restarted
          ? passed(`fresh isolated pid ${state.pid} restarted the plugin process and invoked ${effectiveToolName}`, { restarted: true, restartScope: 'plugin', capabilityObserved: true })
          : failed('restarted MCP process did not expose the tool', { restarted: false, restartScope: 'plugin', capabilityObserved: false })
      }
      if (item.id === 'remove.apply') {
        const removed = await close()
        return removed ? passed('MCP client closed transport and reaped the isolated process', { removePassed: true, processRemoved: true }) : failed('MCP process remained after close', { removePassed: false, processRemoved: false })
      }
      return failed(`MCP adapter does not implement ${item.id}`)
    },
    async cleanup() {
      await close().catch(() => {})
      if (!keepWorkspace) await rm(workspace, { recursive: true, force: true })
      return {
        status: keepWorkspace ? 'failed' : 'passed',
        evidence: keepWorkspace ? `workspace retained by request at ${workspace}` : 'MCP workspace and child process were removed',
        facts: { workspaceRemoved: !keepWorkspace },
      }
    },
  }
}

function parseSkillDocument(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) throw new Error('missing YAML frontmatter')
  const newline = text.startsWith('---\r\n') ? '\r\n' : '\n'
  const closing = `${newline}---${newline}`
  const end = text.indexOf(closing, 3)
  if (end < 0) throw new Error('unterminated YAML frontmatter')
  const source = text.slice(3 + newline.length, end)
  const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false })
  if (document.errors.length > 0) throw new Error(document.errors.map((error) => error.message).join('; '))
  const data = document.toJS()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter must be a YAML object')
  if (!SKILL_NAME_RE.test(data.name || '')) throw new Error('frontmatter name must be kebab-case')
  if (typeof data.description !== 'string' || data.description.trim().length === 0) throw new Error('frontmatter requires a non-empty description')
  if (data.whenToUse !== undefined && typeof data.whenToUse !== 'string') throw new Error('whenToUse must be a string')
  if (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata))) throw new Error('metadata must be an object')
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new Error(`${key} must be a boolean`)
  }
  for (const legacy of ['disableModelInvocation', 'userInvocable']) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field ${legacy} is unsupported`)
  }
  const body = text.slice(end + closing.length)
  if (body.trim().length === 0) throw new Error('skill body must not be empty')
  return { data, body }
}

async function inspectSkillBundle(sourceRoot, artifactPath) {
  if (!contained(sourceRoot, artifactPath)) throw new Error('SKILL.md is outside the source root')
  const sourceReal = await realpath(sourceRoot)
  const artifactReal = await realpath(artifactPath)
  if (!contained(sourceReal, artifactReal)) throw new Error('SKILL.md resolves outside the source root')
  const text = await readFile(artifactReal, 'utf8')
  if (SECRET_RE.test(text)) throw new Error('SKILL.md appears to contain a credential or private key')
  const parsed = parseSkillDocument(text)
  const bundleRoot = dirname(artifactReal)
  let files = 0
  let bytes = 0
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(path, entry.name)
      const info = await lstat(absolute)
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolute)
        if (!contained(bundleRoot, target)) throw new Error(`symlink escapes the skill bundle: ${relative(bundleRoot, absolute)}`)
      } else if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        files += 1
        bytes += info.size
      } else {
        throw new Error(`special file is not allowed: ${relative(bundleRoot, absolute)}`)
      }
      if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) throw new Error('skill bundle exceeds static review limits')
    }
  }
  await walk(bundleRoot)
  const references = []
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0]
    if (!raw || /^(?:https?:|mailto:|#)/i.test(raw)) continue
    if (isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) throw new Error(`skill reference escapes its bundle: ${raw}`)
    const target = resolve(bundleRoot, raw)
    if (!contained(bundleRoot, target) || !await exists(target)) throw new Error(`skill reference is missing or outside the bundle: ${raw}`)
    const targetReal = await realpath(target)
    if (!contained(bundleRoot, targetReal)) throw new Error(`skill reference resolves outside the bundle: ${raw}`)
    references.push(raw)
  }
  const commands = [...text.matchAll(/```(?:bash|sh|zsh|shell|console|powershell|pwsh|cmd)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1].trim()).filter(Boolean)
  const dangerous = commands.filter((command) => DANGEROUS_COMMAND_RE.test(command))
  return { parsed, files, bytes, references, commands, dangerous }
}

export async function createSkillStaticAdapter({
  plan,
  sourceRoot,
  sourceCommit = plan.source.ref,
  fixtureSource = false,
  keepWorkspace = false,
} = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'omdsh-skill-harness-'))
  const packageJson = await readJson(join(sourceRoot, 'package.json'))
  const artifactPath = join(sourceRoot, packageJson.dshWorkshop.integration.artifact)
  let inspection = null
  const inspect = async () => inspection ||= await inspectSkillBundle(sourceRoot, artifactPath)
  return {
    name: 'rc6-skill-static-adapter',
    trustedSourceExecution: true,
    workspace,
    async run(item) {
      const common = await commonAdapterStep(item, { sourceRoot, sourceCommit, plan, packageJson, artifactPath, fixtureSource })
      if (common) return common
      if (item.id === 'protocol.contract') {
        try {
          await inspect()
          return passed('Skill matches the RC.6 one-level filesystem provider contract', { protocolContractValid: true })
        } catch (error) {
          return failed(error.message, { protocolContractValid: false })
        }
      }
      if (item.id === 'skill.frontmatter') {
        try {
          const result = await inspect()
          return passed(`RC.6 frontmatter accepted skill ${result.parsed.data.name}`, { frontmatterValid: true })
        } catch (error) {
          return failed(error.message, { frontmatterValid: false })
        }
      }
      if (item.id === 'skill.references') {
        try {
          const result = await inspect()
          return passed(`checked ${result.files} file(s), ${result.references.length} relative reference(s), ${result.bytes} byte(s)`, { referencesResolved: true, pathsContained: true })
        } catch (error) {
          return failed(error.message, { referencesResolved: false, pathsContained: false })
        }
      }
      if (item.id === 'skill.commands-review') {
        try {
          const result = await inspect()
          return result.dangerous.length === 0
            ? passed(`statically reviewed ${result.commands.length} command block(s); no high-risk pattern found and nothing was executed`, { executableIntentReviewed: true })
            : failed(`high-risk command pattern requires human review: ${short(result.dangerous[0])}`, { executableIntentReviewed: false })
        } catch (error) {
          return failed(error.message, { executableIntentReviewed: false })
        }
      }
      return failed(`Skill adapter does not implement ${item.id}`)
    },
    async cleanup() {
      if (!keepWorkspace) await rm(workspace, { recursive: true, force: true })
      return {
        status: keepWorkspace ? 'failed' : 'passed',
        evidence: keepWorkspace ? `workspace retained by request at ${workspace}` : 'Skill adapter removed its metadata workspace; source was never executed or modified',
        facts: { workspaceRemoved: !keepWorkspace },
      }
    },
  }
}

export { inspectSkillBundle }
