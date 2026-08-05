// Runtime validation for renderer-supplied IPC arguments. The main process is
// the trust boundary: messages are user-readable Chinese and never include
// internal paths, API keys, or stack details.
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcValidationError'
  }
}

// UUIDs and slug-like ids only; rejects path separators, whitespace and quotes.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function assertId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new IpcValidationError(`${name}格式不正确，请刷新后重试。`)
  return value
}

export function assertEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new IpcValidationError(`${name}取值无效。`)
  return value as T
}

export function assertLimit(value: unknown, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > max) throw new IpcValidationError(`数量上限需在 1 到 ${max} 之间。`)
  return Math.floor(value)
}

export function assertString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new IpcValidationError(`${name}必须是文本。`)
  if (value.length > maxLength) throw new IpcValidationError(`${name}长度不能超过 ${maxLength} 个字符。`)
  return value
}

export function assertNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new IpcValidationError(`${name}必须是有效数值。`)
  return value
}
