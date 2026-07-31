export type Rect = { x: number; y: number; width: number; height: number }
export type LabelPoint = { x: number; y: number }

const overlaps = (point: LabelPoint, width: number, height: number, rect: Rect, gap: number): boolean =>
  point.x + width / 2 + gap > rect.x && point.x - width / 2 - gap < rect.x + rect.width && point.y + height / 2 + gap > rect.y && point.y - height / 2 - gap < rect.y + rect.height

/** Picks a nearby point that keeps an edge label away from cards and labels. */
export function placeTopicLabel(base: LabelPoint, size: { width: number; height: number }, cards: Rect[], labels: Rect[], gap = 12): LabelPoint {
  const candidates = [base, ...[1, -1, 2, -2, 3, -3, 4, -4].map((step) => ({ x: base.x, y: base.y + step * 22 }))]
  return candidates.find((point) => ![...cards, ...labels].some((rect) => overlaps(point, size.width, size.height, rect, gap))) ?? base
}
