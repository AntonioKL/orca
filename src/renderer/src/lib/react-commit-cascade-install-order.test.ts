import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The commit shim only lands if it evaluates before react-dom, and react-dom
 * enters the graph through several component modules, not just the entry's own
 * import of react-renderer-root. ES evaluation is depth-first in source order,
 * so the shim wins only while it is the FIRST import statement.
 *
 * Nothing else fails when that stops being true: the diagnostic simply records
 * nothing. This test is the failure.
 */
const RENDERER_ROOT = resolve(__dirname, '..')
const SHIM_IMPORT = "import './lib/react-commit-cascade-observer'"

/** Entries whose crash reports reach the breadcrumb pipe. */
const INSTRUMENTED_ENTRIES = ['main.tsx', 'popout.tsx']
/**
 * The web preload stubs crashReports.recordBreadcrumb to a no-op
 * (src/renderer/src/web/preload-api/web-diagnostics-api.ts), so instrumenting
 * the web entry would cost commits and record nothing.
 */
const UNINSTRUMENTED_ENTRIES = [join('web', 'main.tsx')]

function firstImportStatement(source: string): string | undefined {
  return source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('import '))
}

describe('react commit cascade shim install order', () => {
  for (const entry of INSTRUMENTED_ENTRIES) {
    it(`keeps the shim as the first import in ${entry}`, () => {
      const source = readFileSync(join(RENDERER_ROOT, entry), 'utf8')

      expect(source).toContain(SHIM_IMPORT)
      expect(firstImportStatement(source)).toBe(SHIM_IMPORT)
    })
  }

  for (const entry of UNINSTRUMENTED_ENTRIES) {
    it(`leaves ${entry} uninstrumented, where breadcrumbs are a no-op`, () => {
      const source = readFileSync(join(RENDERER_ROOT, entry), 'utf8')

      expect(source).not.toContain('react-commit-cascade-observer')
    })
  }
})
