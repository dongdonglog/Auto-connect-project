import { describe, expect, it } from 'vitest'
import { detectVectorCapability } from './vector-capability'

describe('detectVectorCapability', () => {
  it('reports sqlite-vec availability with a version string', () => {
    const capability = detectVectorCapability()
    expect(capability.available).toBe(true)
    expect(capability.version).toMatch(/^v?\d+\.\d+/)
    expect(capability.error).toBeNull()
  })

  it('returns a consistent result shape on repeated calls', () => {
    const first = detectVectorCapability()
    const second = detectVectorCapability()
    expect(second).toEqual(first)
  })
})
