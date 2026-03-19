import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto'
import config from '../config.js'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

function getKey() {
  return Buffer.from(config.encryptionKey, 'hex')
}

export function encrypt(plaintext) {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(stored) {
  const [ivHex, tagHex, ciphertextHex] = stored.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256(data, key) {
  return createHmac('sha256', key).update(data).digest('hex')
}
