import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

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

function registrySnapshotId(document) {
  return `sha256:${createHash('sha256').update(canonicalJson(registryPayload(document))).digest('hex')}`
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string' || value === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be canonical base64`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error(`${label} must be canonical base64`)
  return decoded
}

function trustRecord(trustRoots, keyId, { requireActive = true } = {}) {
  if (trustRoots?.schema !== 'omdsh-registry-trust-roots/v1' || !Array.isArray(trustRoots.keys)) {
    throw new Error('unsupported Registry trust-root schema')
  }
  if (new Set(trustRoots.keys.map((entry) => entry.keyId)).size !== trustRoots.keys.length) {
    throw new Error('Registry trust-root key IDs must be unique')
  }
  const matches = trustRoots.keys.filter((entry) => entry.keyId === keyId)
  if (matches.length !== 1) throw new Error(`Registry trust root not found for key ${keyId}`)
  const record = matches[0]
  if (record.algorithm !== 'Ed25519') throw new Error(`Registry trust root ${keyId} is not Ed25519`)
  if (requireActive && record.status !== 'active') throw new Error(`Registry trust root ${keyId} is not active`)
  return record
}

export function registryTrustPublicKey(trustRoots, keyId, options) {
  const record = trustRecord(trustRoots, keyId, options)
  const key = createPublicKey({
    key: decodeCanonicalBase64(record.publicKeySpkiBase64, `Registry trust root ${keyId}`),
    format: 'der',
    type: 'spki',
  })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`Registry trust root ${keyId} must decode to Ed25519`)
  return key
}

export function registryPublicKeySpkiBase64(key) {
  const publicKey = key?.type === 'public' ? key : createPublicKey(key)
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Registry public key must be Ed25519')
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
}

export function assertRegistrySigningKeyMatchesTrustRoot(privateKey, trustRoots, keyId) {
  const signingKey = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('Registry signing key must be Ed25519')
  const trustedKey = registryTrustPublicKey(trustRoots, keyId)
  if (registryPublicKeySpkiBase64(signingKey) !== registryPublicKeySpkiBase64(trustedKey)) {
    throw new Error(`Registry signing key does not match active trust root ${keyId}`)
  }
  return signingKey
}

export function signRegistryDocument(document, { privateKey, keyId }) {
  if (document?.schema !== 'omdsh-registry/v1') throw new Error('unsupported Registry schema')
  if (typeof keyId !== 'string' || keyId.trim() === '') throw new Error('Registry signing key ID is required')
  const payload = registryPayload(document)
  const expectedSnapshot = registrySnapshotId(document)
  if (document.snapshotId !== expectedSnapshot) throw new Error('Registry snapshotId does not match its canonical payload')
  const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Registry signing key must be Ed25519')
  const value = sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64')
  return {
    ...structuredClone(document),
    signature: { algorithm: 'Ed25519', keyId: keyId.trim(), value },
  }
}

export function verifyRegistryDocument(document, { publicKey, keyId = document?.signature?.keyId } = {}) {
  try {
    if (document?.schema !== 'omdsh-registry/v1'
      || document?.signature?.algorithm !== 'Ed25519'
      || typeof document.signature.keyId !== 'string'
      || document.signature.keyId !== keyId
      || document.snapshotId !== registrySnapshotId(document)) return false
    const key = publicKey?.type === 'public' ? publicKey : createPublicKey(publicKey)
    if (key.asymmetricKeyType !== 'ed25519') return false
    const signature = decodeCanonicalBase64(document.signature.value, 'Registry signature')
    return verify(null, Buffer.from(canonicalJson(registryPayload(document))), key, signature)
  } catch {
    return false
  }
}

export function registrySigningPayload(document) {
  return canonicalJson(registryPayload(document))
}
