import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { signRegistryDocument, registrySigningPayload } from '../scripts/registry-signing-lib.mjs'

test('production signing covers the canonical Registry payload without changing the snapshot', async () => {
  const document = JSON.parse(await readFile(new URL('../registry-v1.json', import.meta.url), 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const signed = signRegistryDocument(document, { privateKey, keyId: 'test-2026-08' })
  assert.equal(signed.snapshotId, document.snapshotId)
  assert.equal(signed.signature.algorithm, 'Ed25519')
  assert.equal(verify(
    null,
    Buffer.from(registrySigningPayload(signed)),
    publicKey,
    Buffer.from(signed.signature.value, 'base64'),
  ), true)
  const tampered = structuredClone(signed)
  tampered.revision += 1
  assert.equal(verify(
    null,
    Buffer.from(registrySigningPayload(tampered)),
    publicKey,
    Buffer.from(signed.signature.value, 'base64'),
  ), false)
})
