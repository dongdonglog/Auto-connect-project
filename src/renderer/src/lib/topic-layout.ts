import dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

export function layoutTopic(nodes: Node[], edges: Edge[]): Array<{ materialId: string; x: number; y: number }> {
  const graph = new dagre.graphlib.Graph(); graph.setDefaultEdgeLabel(() => ({})); graph.setGraph({ rankdir: 'LR', nodesep: 130, ranksep: 250, marginx: 100, marginy: 100 })
  nodes.forEach((node) => graph.setNode(node.id, { width: 220, height: 116 })); edges.forEach((edge) => graph.setEdge(edge.source, edge.target)); dagre.layout(graph)
  return nodes.map((node, index) => { const value = graph.node(node.id); return { materialId: node.id, x: value ? value.x - 110 : 120 + (index % 4) * 270, y: value ? value.y - 58 : 120 + Math.floor(index / 4) * 180 } })
}
