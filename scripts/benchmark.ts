/**
 * Material Map 性能基准（合成数据，不依赖外部服务）
 *
 * 运行方式：npm run benchmark
 *
 * 测量指标：
 *  - 导入时间：批量导入 N 份合成 Markdown 材料的总耗时与单份均值
 *  - 增量索引：在已有工作区中新增单份材料的索引耗时（P50/P95）
 *  - Explorer 关系查询：listMaterialRelations 的 P50/P95 延迟
 *
 * 质量门禁：20 / 50 份材料规模下，关系查询 P95 必须 < 1000ms。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WorkspaceService } from '../src/main/workspace-service'

const SCALES = [20, 50, 200] as const
const RELATION_QUERY_P95_GATE_MS = 1_000
const INCREMENTAL_SAMPLES = 10

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index]
}

function stats(samples: number[]): { p50: number; p95: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  }
}

function syntheticDocument(index: number, total: number): { title: string; text: string } {
  const links: string[] = []
  // 链式引用 + 少量跨段引用，模拟真实材料之间的关联密度
  if (index > 0) links.push(`See [previous](doc-${index - 1}.md).`)
  if (index >= 10 && index % 7 === 0) links.push(`Related to [earlier](doc-${index - 10}.md).`)
  const body = Array.from(
    { length: 12 },
    (_, paragraph) =>
      `Paragraph ${paragraph} of document ${index} discusses local evidence token-${index}-${paragraph}, ` +
      `shared-topic-${index % 5} and project milestone planning notes.`,
  ).join('\n\n')
  return { title: `doc-${index}.md`, text: `# Document ${index} of ${total}\n${links.join('\n')}\n${body}` }
}

interface ScaleResult {
  scale: number
  importTotalMs: number
  importMeanMs: number
  incrementalP50Ms: number
  incrementalP95Ms: number
  relationP50Ms: number
  relationP95Ms: number
  relationCount: number
}

async function benchmarkScale(scale: number): Promise<ScaleResult> {
  const root = mkdtempSync(join(tmpdir(), `material-map-bench-${scale}-`))
  try {
    const service = new WorkspaceService()
    await service.create(join(root, 'workspace'), `Bench ${scale}`)

    // 1. 批量导入
    const importStart = performance.now()
    const importSamples: number[] = []
    for (let index = 0; index < scale; index += 1) {
      const doc = syntheticDocument(index, scale)
      const started = performance.now()
      await service.createDocument(doc.title, doc.text, 'md')
      importSamples.push(performance.now() - started)
    }
    const importTotalMs = performance.now() - importStart

    // 2. 单文件增量索引（向已有工作区追加新材料）
    const incrementalSamples: number[] = []
    for (let sample = 0; sample < INCREMENTAL_SAMPLES; sample += 1) {
      const doc = syntheticDocument(scale + sample, scale + INCREMENTAL_SAMPLES)
      const started = performance.now()
      await service.createDocument(`incremental-${sample}.md`, doc.text, 'md')
      incrementalSamples.push(performance.now() - started)
    }

    // 3. Explorer 关系查询（对每份材料查询关联，Explorer 面板的核心路径）
    const materials = service.listMaterials()
    const relationSamples: number[] = []
    let relationCount = 0
    for (const material of materials) {
      const started = performance.now()
      const relations = service.listMaterialRelations(material.id, 5)
      relationSamples.push(performance.now() - started)
      relationCount += relations.length
    }

    const importStats = stats(importSamples)
    const incrementalStats = stats(incrementalSamples)
    const relationStats = stats(relationSamples)
    return {
      scale,
      importTotalMs,
      importMeanMs: importStats.mean,
      incrementalP50Ms: incrementalStats.p50,
      incrementalP95Ms: incrementalStats.p95,
      relationP50Ms: relationStats.p50,
      relationP95Ms: relationStats.p95,
      relationCount,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`
}

async function main(): Promise<void> {
  console.log('Material Map benchmark (synthetic data, local only)\n')
  const results: ScaleResult[] = []
  for (const scale of SCALES) {
    const result = await benchmarkScale(scale)
    results.push(result)
    console.log(
      [
        `scale=${String(result.scale).padStart(3)}`,
        `import total=${ms(result.importTotalMs)} mean/file=${ms(result.importMeanMs)}`,
        `incremental p50=${ms(result.incrementalP50Ms)} p95=${ms(result.incrementalP95Ms)}`,
        `relations p50=${ms(result.relationP50Ms)} p95=${ms(result.relationP95Ms)} (${result.relationCount} hits)`,
      ].join(' | '),
    )
  }

  // 质量门禁：20 / 50 份材料的关系查询 P95 < 1s
  const failures: string[] = []
  for (const result of results) {
    if (result.scale <= 50 && result.relationP95Ms >= RELATION_QUERY_P95_GATE_MS) {
      failures.push(`scale=${result.scale} relation P95 ${ms(result.relationP95Ms)} >= ${RELATION_QUERY_P95_GATE_MS}ms`)
    }
  }
  console.log('')
  if (failures.length) {
    console.error(`GATE FAILED:\n${failures.map((failure) => `  - ${failure}`).join('\n')}`)
    process.exitCode = 1
  } else {
    console.log(`GATE PASSED: relation query P95 < ${RELATION_QUERY_P95_GATE_MS}ms for 20/50-material workspaces`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
