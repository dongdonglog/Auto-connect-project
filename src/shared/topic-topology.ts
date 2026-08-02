export interface TopologyMaterial {
  id: string
  title: string
  sequence: number | null
  sequenceSource: string
  occurredAt: string | null
  importedAt: string
  addedAt: string | null
}

function titleOrdinal(title: string): number | null {
  const match = title.match(/(?:^|\s|[-_])0*(\d{1,4})(?:\s|[-_.]|$)|\u7b2c\s*(\d{1,4})\s*(?:\u7ae0|\u8282|\u8bfe|\u8bb2|\u6b65)|(?:lesson|chapter|step)\s*0*(\d{1,4})/i)
  const value = match?.slice(1).find(Boolean)
  return value ? Number(value) : null
}

export function stableTopicOrder<T extends TopologyMaterial>(materials: T[]): T[] {
  const allManual = materials.length > 0 && materials.every((material) => material.sequenceSource === 'manual' && material.sequence !== null)
  const numbered = materials.map((material) => ({ material, ordinal: titleOrdinal(material.title) }))
  const useTitleOrder = !allManual && numbered.filter((item) => item.ordinal !== null).length * 2 >= materials.length
  return [...numbered].sort((left, right) => {
    if (allManual) return (left.material.sequence ?? Number.MAX_SAFE_INTEGER) - (right.material.sequence ?? Number.MAX_SAFE_INTEGER) || left.material.id.localeCompare(right.material.id)
    if (useTitleOrder && left.ordinal !== null && right.ordinal !== null && left.ordinal !== right.ordinal) return left.ordinal - right.ordinal
    if (useTitleOrder && left.ordinal !== null && right.ordinal === null) return -1
    if (useTitleOrder && left.ordinal === null && right.ordinal !== null) return 1
    return (left.material.occurredAt ?? left.material.importedAt).localeCompare(right.material.occurredAt ?? right.material.importedAt)
      || (left.material.addedAt ?? '').localeCompare(right.material.addedAt ?? '')
      || left.material.title.localeCompare(right.material.title)
      || left.material.id.localeCompare(right.material.id)
  }).map((item) => item.material)
}

export function topologyPositions(materials: TopologyMaterial[]): Array<{ materialId: string; x: number; y: number }> {
  return stableTopicOrder(materials).map((material, index) => ({ materialId: material.id, x: 120 + index * 290, y: 160 }))
}
