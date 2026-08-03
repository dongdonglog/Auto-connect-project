import { describe, expect, it } from 'vitest'
import { assertEnum, assertId, assertLimit, assertNumber, assertString, IpcValidationError } from './ipc-validation'

describe('assertId', () => {
  it('accepts uuid-like and slug ids', () => {
    expect(assertId('550e8400-e29b-41d4-a716-446655440000', '材料标识')).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(assertId('abc-123_X', '材料标识')).toBe('abc-123_X')
  })
  it.each([['empty string', ''], ['path separator', 'a/b'], ['traversal', '../secret'], ['whitespace', 'a b'], ['too long', 'x'.repeat(129)], ['non-string', 123], ['null', null], ['undefined', undefined]])('rejects %s', (_label, value) => {
    expect(() => assertId(value, '材料标识')).toThrowError(IpcValidationError)
  })
  it('uses a readable Chinese message without internal details', () => {
    try { assertId('../etc/passwd', '材料标识'); expect.unreachable() } catch (error) {
      expect(error).toBeInstanceOf(IpcValidationError)
      expect((error as Error).message).toContain('材料标识')
      expect((error as Error).message).not.toContain('/')
    }
  })
})

describe('assertEnum', () => {
  const statuses = ['visible', 'hidden', 'fixed'] as const
  it('accepts an allowed value', () => {
    expect(assertEnum('hidden', statuses, '关系状态')).toBe('hidden')
  })
  it.each([['wrong case', 'VISIBLE'], ['unknown value', 'deleted'], ['non-string', 1], ['undefined', undefined]])('rejects %s', (_label, value) => {
    expect(() => assertEnum(value, statuses, '关系状态')).toThrowError(IpcValidationError)
  })
})

describe('assertLimit', () => {
  it('passes through missing values and floors valid numbers', () => {
    expect(assertLimit(undefined, 20)).toBeUndefined()
    expect(assertLimit(null, 20)).toBeUndefined()
    expect(assertLimit(5, 20)).toBe(5)
    expect(assertLimit(7.9, 20)).toBe(7)
  })
  it.each([['zero', 0], ['negative', -3], ['above max', 21], ['string', '5'], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY]])('rejects %s', (_label, value) => {
    expect(() => assertLimit(value, 20)).toThrowError(IpcValidationError)
  })
})

describe('assertString', () => {
  it('accepts text within the length bound', () => {
    expect(assertString('主题', '主题名称', 80)).toBe('主题')
    expect(assertString('', '主题描述', 500)).toBe('')
  })
  it.each([['too long', 'x'.repeat(81)], ['non-string', 42], ['null', null]])('rejects %s', (_label, value) => {
    expect(() => assertString(value, '主题名称', 80)).toThrowError(IpcValidationError)
  })
})

describe('assertNumber', () => {
  it('accepts finite numbers', () => {
    expect(assertNumber(-12.5, '横坐标')).toBe(-12.5)
  })
  it.each([['NaN', Number.NaN], ['string', '3'], ['undefined', undefined]])('rejects %s', (_label, value) => {
    expect(() => assertNumber(value, '横坐标')).toThrowError(IpcValidationError)
  })
})
