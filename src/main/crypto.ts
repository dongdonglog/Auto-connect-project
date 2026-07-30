import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const PREFIX = Buffer.from('MMAP1')

export const createSalt = () => randomBytes(16).toString('base64')
export const deriveKey = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, 'base64'), 32)

export function encrypt(value: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(value), cipher.final()])
  return Buffer.concat([PREFIX, iv, cipher.getAuthTag(), body])
}

export function decrypt(value: Buffer, key: Buffer): Buffer {
  if (!value.subarray(0, 5).equals(PREFIX)) throw new Error('This workspace data is not a valid encrypted Material Map file.')
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(5, 17))
  decipher.setAuthTag(value.subarray(17, 33))
  return Buffer.concat([decipher.update(value.subarray(33)), decipher.final()])
}
