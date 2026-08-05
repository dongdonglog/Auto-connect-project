import { describe, expect, it } from 'vitest'
import { buildTopicEdgeRoute, segmentHitsRect, segments } from './topic-edge-routing'

function pointIsOnRoute(point: { x: number; y: number }, route: ReturnType<typeof buildTopicEdgeRoute>): boolean {
  return segments(route.points).some((segment) => {
    const between = (value: number, start: number, end: number) => value >= Math.min(start, end) - .01 && value <= Math.max(start, end) + .01
    if (Math.abs(segment.start.y - segment.end.y) < .01) return Math.abs(point.y - segment.start.y) < .01 && between(point.x, segment.start.x, segment.end.x)
    return Math.abs(point.x - segment.start.x) < .01 && between(point.y, segment.start.y, segment.end.y)
  })
}

describe('buildTopicEdgeRoute', () => {
  it('routes an automatic connection around a card between its endpoints', () => {
    const obstacle = { x: 180, y: 50, width: 160, height: 110 }
    const route = buildTopicEdgeRoute({ source: { x: 120, y: 105 }, target: { x: 420, y: 105 }, obstacles: [obstacle] })
    expect(segments(route.points).some((segment) => segmentHitsRect(segment, obstacle))).toBe(false)
  })

  it('puts the label away from cards on a real route segment', () => {
    const obstacle = { x: 180, y: 50, width: 160, height: 110 }
    const route = buildTopicEdgeRoute({ source: { x: 120, y: 105 }, target: { x: 420, y: 105 }, obstacles: [obstacle], labelSize: { width: 80, height: 20 } })
    expect(route.labelRect.x + route.labelRect.width <= obstacle.x || route.labelRect.x >= obstacle.x + obstacle.width || route.labelRect.y + route.labelRect.height <= obstacle.y || route.labelRect.y >= obstacle.y + obstacle.height).toBe(true)
    expect(pointIsOnRoute(route.label, route)).toBe(true)
  })

  it('keeps hand-authored waypoints intact', () => {
    const route = buildTopicEdgeRoute({ source: { x: 0, y: 0 }, target: { x: 200, y: 100 }, obstacles: [], waypoints: [{ x: 80, y: 0 }, { x: 80, y: 100 }] })
    expect(route.points).toEqual([{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 100 }, { x: 200, y: 100 }])
  })

  it('keeps a label away from source and target cards without blocking its route', () => {
    const sourceCard = { x: 0, y: 50, width: 180, height: 110 }
    const targetCard = { x: 340, y: 50, width: 180, height: 110 }
    const route = buildTopicEdgeRoute({ source: { x: 180, y: 105 }, target: { x: 340, y: 105 }, obstacles: [], labelObstacles: [sourceCard, targetCard], labelAnchor: .16, labelSize: { width: 68, height: 20 } })
    expect(route.labelRect.x + route.labelRect.width <= sourceCard.x || route.labelRect.x >= sourceCard.x + sourceCard.width || route.labelRect.y + route.labelRect.height <= sourceCard.y || route.labelRect.y >= sourceCard.y + sourceCard.height).toBe(true)
    expect(route.labelRect.x + route.labelRect.width <= targetCard.x || route.labelRect.x >= targetCard.x + targetCard.width || route.labelRect.y + route.labelRect.height <= targetCard.y || route.labelRect.y >= targetCard.y + targetCard.height).toBe(true)
    expect(pointIsOnRoute(route.label, route)).toBe(true)
  })
})
