import { describe, expect, it } from 'vitest'
import { placeTopicLabel } from './topic-label-placement'

describe('placeTopicLabel', () => {
  it('moves a label away from a card with a stable safety gap', () => {
    const point = placeTopicLabel({ x: 100, y: 100 }, { width: 60, height: 24 }, [{ x: 60, y: 80, width: 100, height: 50 }], [])
    expect(point).not.toEqual({ x: 100, y: 100 })
  })
})
