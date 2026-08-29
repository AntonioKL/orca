import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the envelope chokepoint at the tree level rather than per call site.
 *
 * `ipcRenderer.invoke` rejects with Electron's envelope, and the renderer's ordinary idiom renders
 * `err.message`. That made the leak unfixable per site: the shape that leaks is the shape that is
 * correct everywhere else, so a lint rule keyed on it fires on hundreds of sound lines. Routing the
 * 731 call sites through one wrapper fixed them at once — this test is what stops the 732nd from
 * being written outside it.
 *
 * The `electronAPI` bridge is covered too, because `contextBridge.exposeInMainWorld('electron', …)`
 * hands the renderer a raw `ipcRenderer` whose `invoke` never reaches the wrapper. Nothing uses that
 * door today; the point of a ratchet is that it stays shut before something does.
 */
const BOUNDARY_MODULE = 'src/preload/ipc-invoke-boundary.ts'
const SRC_ROOT = resolve(__dirname, '..')
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/** Whitespace and newlines are legal between the receiver and the call, and one call site used them. */
const RAW_INVOKE = /ipcRenderer\s*\.\s*invoke\s*\(/
/** Not anchored on `window`: a cast (`(window as unknown as { electron: … }).electron.ipcRenderer`)
 *  sits between `window` and `.electron`, and aliasing the receiver hides the call from RAW_INVOKE
 *  as well — so a `window`-anchored arm 2 passed with a live raw-bridge escape in the tree. Typing
 *  the global does not close that door: `Window.electron` IS declared (`src/preload/api-types.ts`),
 *  and the cast spelling still compiles. The lookbehind keeps `electronFoo.ipcRenderer` out. */
const RAW_BRIDGE = /(?<!\w)electron\s*\.\s*ipcRenderer/

/**
 * Comments name this shape on purpose — the modules that consume the envelope explain where it
 * comes from — so the scan reads code only. A ratchet that fired on prose would be silenced by
 * rewording rather than by fixing anything.
 */
function withoutCommentsOrStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''")
}

/** Tests may reach for the raw call: they are not shipped, and several drive it to prove the wrapper. */
function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !isTestFile(full)) {
      found.push(full)
    }
  }
  return found
}

function offendingModules(pattern: RegExp): string[] {
  return collectSourceFiles(SRC_ROOT)
    .filter((file) => pattern.test(withoutCommentsOrStrings(readFileSync(file, 'utf8'))))
    .map((file) => relative(resolve(SRC_ROOT, '..'), file).replaceAll('\\', '/'))
    .sort()
}

describe('ipcRenderer.invoke stays behind the preload boundary', () => {
  it('is called in exactly one module', () => {
    expect(offendingModules(RAW_INVOKE)).toEqual([BOUNDARY_MODULE])
  })

  it('is not reachable through the raw electron bridge either', () => {
    expect(offendingModules(RAW_BRIDGE)).toEqual([])
  })

  /** A scan that matched nothing anywhere would pass both assertions above while enforcing nothing. */
  it('scans the modules it claims to', () => {
    const files = collectSourceFiles(SRC_ROOT)

    expect(files.length).toBeGreaterThan(500)
    expect(files.some((file) => file.endsWith('preload/index.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('preload/gitlab.ts'))).toBe(true)
  })
})
