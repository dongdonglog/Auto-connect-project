import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const readmes = ['README.md', 'README-EN.md']
const refs = /\]\(([^)]+)\)|(?:src|href)=["']([^"']+)["']/g
const external = /^(?:https?:|mailto:|data:|#)/i
const missing = []

for (const file of readmes) {
  const text = readFileSync(resolve(root, file), 'utf8')
  for (const match of text.matchAll(refs)) {
    const reference = (match[1] ?? match[2] ?? '').trim()
    if (!reference || external.test(reference)) continue
    const path = reference.split('#', 1)[0].split('?', 1)[0]
    if (path && !existsSync(resolve(root, path))) missing.push(`${file}: ${path}`)
  }
}

if (missing.length) {
  console.error('Missing README references:')
  for (const item of missing) console.error(`- ${item}`)
  process.exitCode = 1
} else {
  console.log(`README references OK (${readmes.join(', ')})`)
}
