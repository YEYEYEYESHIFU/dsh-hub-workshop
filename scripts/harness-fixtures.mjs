import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
export const FIXTURE_COMMIT = '6'.repeat(40)
export const FIXTURE_PREVIOUS_COMMIT = '5'.repeat(40)
export const FIXTURE_VERIFIED_AT = '2026-08-14T06:00:00.000Z'

const FIXTURES = Object.freeze({
  profile: {
    projectId: 'harness-profile',
    repository: 'https://github.com/omdsh-dev/harness-profile-fixture',
    sourceRoot: join(ROOT, 'tests', 'fixtures', 'profile-bundle-v2'),
    previousSourceRoot: join(ROOT, 'tests', 'fixtures', 'profile-bundle-v1'),
    previousVersion: '1.0.0',
    method: 'profile-bundle',
    kind: 'extension',
  },
  mcp: {
    projectId: 'harness-mcp',
    repository: 'https://github.com/omdsh-dev/harness-mcp-fixture',
    sourceRoot: join(ROOT, 'tests', 'fixtures', 'mcp-process'),
    method: 'guided',
    kind: 'mcp',
  },
  skill: {
    projectId: 'harness-skill',
    repository: 'https://github.com/omdsh-dev/harness-skill-fixture',
    sourceRoot: join(ROOT, 'tests', 'fixtures', 'skill-static'),
    method: 'guided',
    kind: 'skill',
  },
})

export function fixtureDefinition(kind) {
  const fixture = FIXTURES[kind]
  if (!fixture) throw new Error(`unknown Harness fixture: ${kind}`)
  return fixture
}

export async function fixtureSubmission(kind) {
  const fixture = fixtureDefinition(kind)
  const packageJson = JSON.parse(await readFile(join(fixture.sourceRoot, 'package.json'), 'utf8'))
  const declaration = structuredClone(packageJson.dshWorkshop)
  const transactional = fixture.method === 'profile-bundle'
  return {
    schema: 'omdsh-workshop-submission/v2',
    operation: transactional ? 'add-release' : 'create-project',
    project: {
      id: fixture.projectId,
      displayName: `Local ${kind.toUpperCase()} Harness fixture`,
      summary: 'Local-only fixture for validating a typed Workshop Harness adapter.',
      kind: fixture.kind,
      category: 'developer-tools',
      tags: ['dsh-plugin', 'harness-fixture'],
      repository: fixture.repository,
      path: null,
      author: { name: 'omdsh-dev', url: 'https://github.com/omdsh-dev' },
      license: 'MIT',
      media: null,
    },
    release: {
      version: packageJson.version,
      ref: FIXTURE_COMMIT,
      updatedAt: FIXTURE_VERIFIED_AT,
      channel: 'stable',
      compatibility: 'Local fixture pinned to the public @deepseek-ai/dsh@0.1.0-rc.6 baseline.',
      changelog: 'Typed adapter verification fixture.',
      capabilities: {
        requiresFabric: false,
        deepHook: false,
        restartRequired: declaration.lifecycle.activation.startsWith('restart-'),
      },
      profileBundle: transactional
        ? { packageName: packageJson.name, spec: `github:omdsh-dev/harness-profile-fixture#${FIXTURE_COMMIT}` }
        : null,
      updateFrom: transactional ? { version: fixture.previousVersion, ref: FIXTURE_PREVIOUS_COMMIT } : null,
    },
    management: {
      method: fixture.method,
      protocol: declaration.integration.protocol,
      label: transactional ? 'Install after admission' : 'View integration guide',
      instructions: transactional
        ? 'Install the fixed fixture in an isolated candidate Profile.'
        : `Review the local fixture contract corresponding to ${fixture.repository}/tree/${FIXTURE_COMMIT}.`,
      source: null,
    },
    declarations: {
      permissions: 'Only the permissions declared by the local fixture are exercised.',
      testing: 'Run the matching typed adapter in an ephemeral, deny-network workspace.',
      trustedPublisherRequested: false,
      installScriptsMustRemainDisabled: true,
    },
    packageManifest: declaration,
  }
}
