import { describe, expect, it } from 'vitest'
import { createSalt, decrypt, deriveKey, encrypt } from './crypto'

describe('crypto', () => {
  it('createSalt returns unique base64-encoded 16-byte salts', () => {
    const first = createSalt()
    const second = createSalt()
    expect(first).not.toBe(second)
    expect(Buffer.from(first, 'base64')).toHaveLength(16)
  })

  it('deriveKey is deterministic for the same password and salt', () => {
    const salt = createSalt()
    const keyA = deriveKey('correct horse battery staple', salt)
    const keyB = deriveKey('correct horse battery staple', salt)
    expect(keyA.equals(keyB)).toBe(true)
    expect(keyA).toHaveLength(32)
  })

  it('deriveKey produces different keys for different salts or passwords', () => {
    const salt = createSalt()
    expect(deriveKey('one', salt).equals(deriveKey('two', salt))).toBe(false)
    expect(deriveKey('one', createSalt()).equals(deriveKey('one', createSalt()))).toBe(false)
  })

  it('encrypt/decrypt round-trips arbitrary binary data', () => {
    const key = deriveKey('workspace password', createSalt())
    const payload = Buffer.from('Material Map secret payload \u0000\u00ff binary')
    const encrypted = encrypt(payload, key)
    expect(encrypted.equals(payload)).toBe(false)
    expect(decrypt(encrypted, key).equals(payload)).toBe(true)
  })

  it('encrypt produces different ciphertext for identical input (random IV)', () => {
    const key = deriveKey('pw', createSalt())
    const payload = Buffer.from('same input')
    expect(encrypt(payload, key).equals(encrypt(payload, key))).toBe(false)
  })

  it('decrypt fails with a wrong key', () => {
    const payload = Buffer.from('confidential')
    const encrypted = encrypt(payload, deriveKey('right', createSalt()))
    expect(() => decrypt(encrypted, deriveKey('wrong', createSalt()))).toThrow()
  })

  it('decrypt rejects data without the MMAP1 prefix', () => {
    const key = deriveKey('pw', createSalt())
    expect(() => decrypt(Buffer.from('not-an-encrypted-file'), key)).toThrow(/not a valid encrypted Material Map file/)
  })

  it('decrypt rejects tampered ciphertext (GCM auth tag)', () => {
    const key = deriveKey('pw', createSalt())
    const encrypted = encrypt(Buffer.from('integrity matters'), key)
    encrypted[encrypted.length - 1] ^= 0xff
    expect(() => decrypt(encrypted, key)).toThrow()
  })
})
