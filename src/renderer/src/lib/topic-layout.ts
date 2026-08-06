import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

export function layoutTopic(nodes: Node[], edges: Edge[]): Array<{ materialId: string; x: number; y: number }> {
  const width = 220; const height = 116
  // Dagre places every unconnected node in one rank. Keep an empty topic
  // useful and predictable by arranging those cards in a horizontal grid.
  if (!edges.length) return nodes.map((node, index) => ({ materialId: node.id, x: 120 + (index % 4) * 340, y: 120 + Math.floor(index / 4) * 210 }))
  const graph = new dagre.graphlib.Graph(); graph.setDefaultEdgeLabel(() => ({})); graph.setGraph({ rankdir: 'LR', nodesep: 150, ranksep: 280, marginx: 100, marginy: 100 })
  nodes.forEach((node) => graph.setNode(node.id, { width, height })); edges.forEach((edge) => graph.setEdge(edge.source, edge.target)); dagre.layout(graph)
  return nodes.map((node, index) => { const value = graph.node(node.id); return { materialId: node.id, x: value ? value.x - width / 2 : 120 + (index % 4) * 340, y: value ? value.y - height / 2 : 120 + Math.floor(index / 4) * 210 } })
}
