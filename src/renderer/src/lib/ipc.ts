/** Typed renderer facade. Feature components do not assemble IPC channel names. */
export const ipc = {
  topic: {
    map: (topicId: string) => window.materialMap.topics.map(topicId),
    addMaterial: (topicId: string, materialId: string) => window.materialMap.topics.addMaterial(topicId, materialId),
    removeMaterial: (topicId: string, materialId: string) => window.materialMap.topics.removeMaterial(topicId, materialId),
    position: (topicId: string, materialId: string, x: number, y: number) => window.materialMap.topics.positionMaterial(topicId, materialId, x, y),
    layout: (topicId: string, positions: Array<{ materialId: string; x: number; y: number }>) => window.materialMap.topics.layout(topicId, positions),
    command: (topicId: string, command: { kind: string; payload: Record<string, unknown> }) => window.materialMap.topics.executeCommand(topicId, command),
    undo: (topicId: string) => window.materialMap.topics.undo(topicId),
    redo: (topicId: string) => window.materialMap.topics.redo(topicId),
    history: (topicId: string) => window.materialMap.topics.history(topicId),
    proposals: (topicId: string) => window.materialMap.topics.proposals(topicId),
    acceptProposal: (topicId: string, proposalId: string) => window.materialMap.topics.acceptProposal(topicId, proposalId),
    acceptProposals: (topicId: string, proposalIds: string[]) => window.materialMap.topics.acceptProposals(topicId, proposalIds),
    archiveProposal: (topicId: string, proposalId: string) => window.materialMap.topics.archiveProposal(topicId, proposalId),
    rebuildTopology: (topicId: string) => window.materialMap.topics.rebuildTopology(topicId),
    updateView: (topicId: string, input: { viewMode?: 'map' | 'flow'; confirmedOnly?: boolean }) => window.materialMap.topics.updateView(topicId, input),
    planCanvas: (input: import('../types').CanvasAiRequest) => window.materialMap.planCanvas(input),
    cardStyle: (topicId: string, materialId: string, input: { color?: string; tags?: string[]; note?: string }) => window.materialMap.topics.updateCardStyle(topicId, materialId, input),
    relationStyle: (topicId: string, relationId: string, input: Parameters<typeof window.materialMap.topics.updateRelationStyle>[2]) => window.materialMap.topics.updateRelationStyle(topicId, relationId, input)
  },
  material: {
    createNote: (title: string, text: string) => window.materialMap.materials.note(title, text),
    chooseFiles: () => window.materialMap.chooseFiles()
  },
  relation: {
    create: (input: Parameters<typeof window.materialMap.relations.create>[0]) => window.materialMap.relations.create(input),
    update: (id: string, label: string) => window.materialMap.relations.update(id, label),
    remove: (id: string) => window.materialMap.relations.delete(id)
  },
  cardOrder: {
    update: (topicId: string, materialId: string, sequence: number) => window.materialMap.cardOrder.update(topicId, materialId, sequence)
  },
  workstream: {
    create: (topicId: string, name: string) => window.materialMap.workstreams.create(topicId, name),
    move: (topicId: string, materialId: string, workstreamId: string | null) => window.materialMap.workstreams.moveMaterial(topicId, materialId, workstreamId)
  }
}
