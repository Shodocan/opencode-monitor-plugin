import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const distTui = join(root, 'dist', 'tui.js')

describe('tui build output', () => {
  it('builds a solid-compiled dist/tui.js entry', async () => {
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-tui.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(distTui)).toBe(true)
    expect(existsSync(join(root, 'dist', 'tui.jsx'))).toBe(false)
    const code = readFileSync(distTui, 'utf8')
    expect(code).not.toMatch(/<[A-Za-z][\w.-]*[\s/>]/)
    expect(code).not.toMatch(/from ['"]\.\/status-store\.ts['"]/)
    expect(code).toMatch(/solid-js/)
    expect(code).toMatch(/@opentui\/solid/)
    const mod = await import(`${pathToFileURL(distTui).href}?t=${Date.now()}`)
    expect(mod.default.id).toBe('opencode-monitor-indicator')
    expect(typeof mod.default.tui).toBe('function')
    expect(typeof mod.tui).toBe('function')
  })
})
