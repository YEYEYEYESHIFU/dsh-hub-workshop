import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveDshBaseline } from '../scripts/dsh-baseline-lib.mjs'

const current = JSON.parse(await readFile(new URL('../official-baseline.json', import.meta.url), 'utf8'))

test('current DSH baseline is reused without a registry request', async () => {
  const baseline = await resolveDshBaseline(current.runtime.version, current, {
    fetchImpl: async () => { throw new Error('unexpected fetch') }
  })
  assert.deepEqual(baseline, current)
  assert.notEqual(baseline, current)
})

test('declared DSH baseline binds runtime and Profile packages to exact npm integrities', async () => {
  const requested = []
  const fetchImpl = async (url) => {
    requested.push(url)
    const decoded = decodeURIComponent(url)
    const name = decoded.includes('@deepseek-ai/dsh-web-app') ? '@deepseek-ai/dsh-web-app'
      : decoded.includes('@deepseek-ai/dsh-base') ? '@deepseek-ai/dsh-base'
        : '@deepseek-ai/dsh'
    return {
      ok: true,
      json: async () => ({ name, version: '0.1.0-rc.2', dist: { integrity: `sha512-${name.replace(/[^a-z]/gi, '')}` } })
    }
  }
  const baseline = await resolveDshBaseline('0.1.0-rc.2', current, { fetchImpl })
  assert.equal(requested.length, 3)
  assert.equal(baseline.runtime.version, '0.1.0-rc.2')
  assert.equal(baseline.contracts.profileBundle.templates.web.exactPackages.length, 2)
  assert.ok(baseline.contracts.profileBundle.templates.web.exactPackages.every((item) => item.version === '0.1.0-rc.2'))
})
