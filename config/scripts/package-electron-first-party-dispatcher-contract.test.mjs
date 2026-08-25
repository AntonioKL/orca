import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

// Why its own file: package-electron-runtime-contract.test.mjs sits at the
// max-lines ceiling, and this contract is narrower than the rest of that suite.
// Why it matters: the scoped dispatcher is what carries the merged trust store for
// Orca-owned traffic on the Node side. If undici is missing from a packaged
// runtime, first-party HTTPS silently falls back to Node's bundled roots and dies
// with a bare transport error on any host whose chain terminates outside them.
describe('packaged first-party dispatcher contract', () => {
  it('includes the scoped first-party HTTP dispatcher in every packaged runtime', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const packagedTargets = createPackagedRuntimeNodeModuleResources(platform).map(
        (resource) => resource.to
      )
      expect(packagedTargets).toContain(join('node_modules', 'undici'))
    }
  })
})
