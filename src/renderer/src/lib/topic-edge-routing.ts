export type Point = { x: number; y: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type Segment = { start: Point; end: Point }

export type EdgeRoute = {
  points: Point[]
  path: string
  label: Point
  labelRect: Rect
}

const EPSILON = .01
const distance = (left: Point, right: Point): number => Math.hypot(right.x - left.x, right.y - left.y)
const samePoint = (left: Point, right: Point): boolean => Math.abs(left.x - right.x) < EPSILON && Math.abs(left.y - right.y) < EPSILON
const isHorizontal = (segment: Segment): boolean => Math.abs(segment.start.y - segment.end.y) < EPSILON
const intersects = (first: number, second: number, low: number, high: number): boolean => Math.max(Math.min(first, second), low) < Math.min(Math.max(first, second), high)

export function segments(points: Point[]): Segment[] {
  return points.slice(1).map((point, index) => ({ start: points[index], end: point })).filter((segment) => !samePoint(segment.start, segment.end))
}

export function segmentHitsRect(segment: Segment, rect: Rect, padding = 8): boolean {
  const left = rect.x - padding; const right = rect.x + rect.width + padding
  const top = rect.y - padding; const bottom = rect.y + rect.height + padding
  if (isHorizontal(segment)) return segment.start.y > top && segment.start.y < bottom && intersects(segment.start.x, segment.end.x, left, right)
  if (Math.abs(segment.start.x - segment.end.x) < EPSILON) return segment.start.x > left && segment.start.x < right && intersects(segment.start.y, segment.end.y, top, bottom)
  // Manual diagonal segments are only used by the straight style. A simple
  // bounding-box check keeps their label away from card interiors.
  return intersects(segment.start.x, segment.end.x, left, right) && intersects(segment.start.y, segment.end.y, top, bottom)
}

function routeScore(points: Point[], obstacles: Rect[]): number {
  const routeSegments = segments(points)
  const collisions = routeSegments.reduce((count, segment) => count + obstacles.filter((rect) => segmentHitsRect(segment, rect)).length, 0)
  return collisions * 1_000_000 + routeSegments.reduce((sum, segment) => sum + distance(segment.start, segment.end), 0) + Math.max(0, routeSegments.length - 1) * 22
}

function orthogonalCandidates(source: Point, target: Point, obstacles: Rect[], spread: number): Point[][] {
  const horizontal = Math.abs(target.x - source.x) >= Math.abs(target.y - source.y)
  const midpoint = horizontal ? (source.y + target.y) / 2 + spread : (source.x + target.x) / 2 + spread
  const top = Math.min(source.y, target.y, ...obstacles.map((rect) => rect.y)) - 42 - Math.abs(spread)
  const bottom = Math.max(source.y, target.y, ...obstacles.map((rect) => rect.y + rect.height)) + 42 + Math.abs(spread)
  const left = Math.min(source.x, target.x, ...obstacles.map((rect) => rect.x)) - 42 - Math.abs(spread)
  const right = Math.max(source.x, target.x, ...obstacles.map((rect) => rect.x + rect.width)) + 42 + Math.abs(spread)
  return horizontal
    ? [[source, { x: target.x, y: source.y }, target], [source, { x: source.x + 34, y: midpoint }, { x: target.x - 34, y: midpoint }, target], [source, { x: source.x + 34, y: top }, { x: target.x - 34, y: top }, target], [source, { x: source.x + 34, y: bottom }, { x: target.x - 34, y: bottom }, target]]
    : [[source, { x: source.x, y: target.y }, target], [source, { x: midpoint, y: source.y + 34 }, { x: midpoint, y: target.y - 34 }, target], [source, { x: left, y: source.y + 34 }, { x: left, y: target.y - 34 }, target], [source, { x: right, y: source.y + 34 }, { x: right, y: target.y - 34 }, target]]
}

function compact(points: Point[]): Point[] {
  return points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]))
}

function pointOnSegment(segment: Segment, ratio: number): Point {
  return { x: segment.start.x + (segment.end.x - segment.start.x) * ratio, y: segment.start.y + (segment.end.y - segment.start.y) * ratio }
}

function rectAt(center: Point, width: number, height: number): Rect { return { x: center.x - width / 2, y: center.y - height / 2, width, height } }
function rectCollides(rect: Rect, obstacles: Rect[]): boolean { return obstacles.some((obstacle) => rect.x < obstacle.x + obstacle.width + 8 && rect.x + rect.width > obstacle.x - 8 && rect.y < obstacle.y + obstacle.height + 8 && rect.y + rect.height > obstacle.y - 8) }

function labelPosition(points: Point[], obstacles: Rect[], labelSize: { width: number; height: number }, anchor: number): { point: Point; rect: Rect } {
  const routeSegments = segments(points)
  const ordered = [...routeSegments].sort((left, right) => {
    const horizontalOrder = Number(isHorizontal(right)) - Number(isHorizontal(left))
    return horizontalOrder || distance(right.start, right.end) - distance(left.start, left.end)
  })
  for (const segment of ordered) {
    const length = distance(segment.start, segment.end)
    const requiredLength = isHorizontal(segment) ? Math.min(72, labelSize.width + 18) : labelSize.height + 18
    if (length < requiredLength) continue
    // A relationship label is part of the connection, rather than a floating
    // annotation beside it. Try alternate positions on this same segment when
    // its preferred anchor would overlap a card.
    const ratios = [...new Set([Math.max(.16, Math.min(.84, anchor)), .5, .25, .75, .16, .84])]
    for (const ratio of ratios) {
      const point = pointOnSegment(segment, ratio)
      const rect = rectAt(point, labelSize.width, labelSize.height)
      if (length >= Math.min(72, labelSize.width + 18) && !rectCollides(rect, obstacles)) return { point, rect }
    }
  }
  const fallbackSegment = ordered[0]
  const fallback = fallbackSegment ? pointOnSegment(fallbackSegment, .5) : points[Math.floor(points.length / 2)] ?? { x: 0, y: 0 }
  return { point: fallback, rect: rectAt(fallback, labelSize.width, labelSize.height) }
}

export function buildTopicEdgeRoute(input: { source: Point; target: Point; obstacles: Rect[]; labelObstacles?: Rect[]; waypoints?: Point[]; spread?: number; labelSize?: { width: number; height: number }; labelAnchor?: number }): EdgeRoute {
  const source = input.source; const target = input.target
  const points = input.waypoints?.length ? compact([source, ...input.waypoints, target]) : compact(orthogonalCandidates(source, target, input.obstacles, input.spread ?? 0).sort((left, right) => routeScore(left, input.obstacles) - routeScore(right, input.obstacles))[0] ?? [source, target])
  const label = labelPosition(points, input.labelObstacles ?? input.obstacles, input.labelSize ?? { width: 86, height: 22 }, input.labelAnchor ?? .5)
  return { points, path: points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' '), label: label.point, labelRect: label.rect }
}
