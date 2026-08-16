import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertRegistrySigningKeyMatchesTrustRoot,
  registryPublicKeySpkiBase64,
  registryTrustPublicKey,
  signRegistryDocument,
  verifyRegistryDocument,
} from '../scripts/registry-signing-lib.mjs'

function trustRoots(publicKey, status = 'active') {
  return {
    schema: 'omdsh-registry-trust-roots/v1',
    keys: [{
      keyId: 'test-2026-08',
      algorithm: 'Ed25519',
      publicKeySpkiBase64: registryPublicKeySpkiBase64(publicKey),
      status,
      validFrom: '2026-08-15T00:00:00.000Z',
    }],
  }
}

test('production signing covers the canonical Registry payload without changing the snapshot', async () => {
  const document = JSON.parse(await readFile(new URL('../registry-v1.json', import.meta.url), 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const roots = trustRoots(publicKey)
  const boundKey = assertRegistrySigningKeyMatchesTrustRoot(privateKey, roots, 'test-2026-08')
  const signed = signRegistryDocument(document, { privateKey: boundKey, keyId: 'test-2026-08' })
  assert.equal(signed.snapshotId, document.snapshotId)
  assert.equal(signed.signature.algorithm, 'Ed25519')
  const trustedKey = registryTrustPublicKey(roots, signed.signature.keyId)
  assert.equal(verifyRegistryDocument(signed, { publicKey: trustedKey }), true)
  const tampered = structuredClone(signed)
  tampered.revision += 1
  assert.equal(verifyRegistryDocument(tampered, { publicKey: trustedKey }), false)
})

test('signing fails closed for a mismatched or inactive trust root', () => {
  const signer = generateKeyPairSync('ed25519')
  const stranger = generateKeyPairSync('ed25519')
  assert.throws(
    () => assertRegistrySigningKeyMatchesTrustRoot(signer.privateKey, trustRoots(stranger.publicKey), 'test-2026-08'),
    /does not match active trust root/,
  )
  assert.throws(
    () => assertRegistrySigningKeyMatchesTrustRoot(signer.privateKey, trustRoots(signer.publicKey, 'retired'), 'test-2026-08'),
    /is not active/,
  )
})
