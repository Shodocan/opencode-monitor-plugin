import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformAsync } from '@babel/core'
import ts from '@babel/preset-typescript'
import solid from 'babel-preset-solid'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src', 'tui.tsx')
const out = join(root, 'dist', 'tui.js')

const code = readFileSync(src, 'utf8')
const result = await transformAsync(code, {
  filename: src,
  configFile: false,
  babelrc: false,
  presets: [
    [solid, { moduleName: '@opentui/solid', generate: 'universal' }],
    [ts, { isTSX: true, allExtensions: true }],
  ],
})

if (!result?.code) {
  console.error('build-tui: transform produced empty output')
  process.exit(1)
}

// Sanity checks — reject leftover JSX tags and source-path imports.
// Strip comments before checking to avoid false positives from JSX in comments.
const codeNoComments = result.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
if (/<[A-Za-z][\w.-]*[\s/>]/.test(codeNoComments)) {
  console.error('build-tui: untransformed JSX remains in output')
  process.exit(1)
}
if (result.code.includes('./status-store.ts') || result.code.includes("from 'src/") || result.code.includes('from "src/')) {
  console.error('build-tui: output must not import src/ or .ts paths')
  process.exit(1)
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, result.code + (result.code.endsWith('\n') ? '' : '\n'))

// tsc with jsx:preserve emits a stale dist/tui.jsx; remove it so packs only ship
// the Solid-compiled dist/tui.js entry.
for (const stale of ['tui.jsx', 'tui.jsx.map']) {
  try {
    rmSync(join(root, 'dist', stale), { force: true })
  } catch {
    // ignore
  }
}

console.log(`build-tui: wrote ${out}`)
