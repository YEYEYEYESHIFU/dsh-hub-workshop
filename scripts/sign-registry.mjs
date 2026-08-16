#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { signRegistryDocument } from './registry-signing-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET = resolve(ROOT, '.public-site/registry-v1.json')
const keyId = process.env.OMDSH_REGISTRY_SIGNING_KEY_ID || ''
const encodedKey = process.env.OMDSH_REGISTRY_SIGNING_KEY_B64 || ''
if (!encodedKey) throw new Error('OMDSH_REGISTRY_SIGNING_KEY_B64 is required')
if (!keyId) throw new Error('OMDSH_REGISTRY_SIGNING_KEY_ID is required')

let privateKey
try {
  privateKey = Buffer.from(encodedKey, 'base64').toString('utf8')
} catch {
  throw new Error('OMDSH_REGISTRY_SIGNING_KEY_B64 is not valid base64')
}
if (!privateKey.includes('PRIVATE KEY')) throw new Error('decoded Registry signing key is not a PEM private key')

const document = JSON.parse(await readFile(TARGET, 'utf8'))
if (document.signature !== null) throw new Error('production Registry artifact is already signed')
const signed = signRegistryDocument(document, { privateKey, keyId })
const temporary = `${TARGET}.${process.pid}.tmp`
await writeFile(temporary, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 })
await rename(temporary, TARGET)
console.log(`signed production Registry snapshot ${signed.snapshotId} with key ${signed.signature.keyId}`)
