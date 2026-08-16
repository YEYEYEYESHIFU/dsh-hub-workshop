import { createHash, createPrivateKey, sign } from 'node:crypto'

import { canonicalJson } from './build-install-feeds.mjs'

function registryPayload(document) {
  return {
    schema: document.schema,
    revision: document.revision,
    generatedAt: document.generatedAt,
    origins: document.origins,
    entries: document.entries,
    collections: document.collections,
  }
}

export function signRegistryDocument(document, { privateKey, keyId }) {
  if (document?.schema !== 'omdsh-registry/v1') throw new Error('unsupported Registry schema')
  if (typeof keyId !== 'string' || keyId.trim() === '') throw new Error('Registry signing key ID is required')
  const payload = registryPayload(document)
  const expectedSnapshot = `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
  if (document.snapshotId !== expectedSnapshot) throw new Error('Registry snapshotId does not match its canonical payload')
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Registry signing key must be Ed25519')
  const value = sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64')
  return {
    ...structuredClone(document),
    signature: { algorithm: 'Ed25519', keyId: keyId.trim(), value },
  }
}

export function registrySigningPayload(document) {
  return canonicalJson(registryPayload(document))
}
