import assert from 'node:assert/strict'
import test from 'node:test'

import publicWorker, { __test } from '../worker/public.js'

function env(bindings = {}) {
  return {
    ...bindings,
    ASSETS: {
      fetch: async (request) => new Response(`asset:${new URL(request.url).pathname}`, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    },
  }
}

test('the public catalog is anonymous and indexable', async () => {
  const response = await publicWorker.fetch(new Request('https://hub.omdsh.dev/'), env())
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'asset:/')
  assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
  assert.equal(response.headers.get('x-robots-tag'), null)
})

test('the public CSP permits only the Cloudflare Web Analytics endpoints', async () => {
  const response = await publicWorker.fetch(new Request('https://hub.omdsh.dev/'), env())
  const csp = response.headers.get('content-security-policy')
  assert.match(csp, /connect-src 'self' https:\/\/cloudflareinsights\.com/)
  assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/)
  assert.doesNotMatch(csp, /\*/)
})

test('the Worker never injects a second Web Analytics beacon', async () => {
  for (const hostname of ['hub.omdsh.dev', 'hub.0.org.cn', 'preview.example']) {
    const response = await publicWorker.fetch(new Request(`https://${hostname}/`), env())
    assert.doesNotMatch(await response.text(), /cloudflareinsights/)
  }
})

test('retired login and private session endpoints remain unavailable', async () => {
  for (const path of ['/access', '/api/session', '/auth/github', '/auth/callback', '/auth/logout']) {
    assert.equal(__test.isPrivatePath(path), true, path)
    const response = await publicWorker.fetch(new Request(`https://hub.omdsh.dev${path}`), env())
    assert.equal(response.status, 404, path)
    assert.equal(await response.text(), '', path)
  }
})

test('public feeds, project directory, and repository mappings require no session', async () => {
  for (const path of ['/automation-policy.json', '/automation-policy.schema.json', '/loader-adapter.schema.json', '/loader-adapters.json', '/catalog.json', '/registry-v1.json', '/registry-trust-roots.json', '/registry-trust-roots.schema.json', '/recipes-v1.json', '/agent-ecosystem-v1.json', '/api/v1/ecosystem.json', '/api/v1/market.json', '/api/v1/plugin-types.json', '/api/v1/plugins.json', '/ecosystem-repositories.json', '/public-discovery.json', '/topic-repositories.json', '/topic-plugin-audit.json', '/official-baseline.json', '/intake-queue.json', '/intake.schema.json', '/intake-evidence.schema.json', '/harness-plan.schema.json', '/harness-report.schema.json', '/market-layers.json', '/market-layers.schema.json', '/verification-inventory.json', '/distribution.schema.json', '/distribution-intake-queue.json', '/distribution-intake.schema.json', '/distributions-v1.json', '/distributions-v1.schema.json', '/profile-pack.schema.json', '/profile-pack-envelope.schema.json', '/projects.html']) {
    const response = await publicWorker.fetch(new Request(`https://hub.omdsh.dev${path}`), env())
    assert.equal(response.status, 200, path)
    assert.equal(await response.text(), `asset:${path}`, path)
  }
})
