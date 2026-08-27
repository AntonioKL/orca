/**
 * Installs the React devtools commit hook before the test module graph.
 *
 * Why a setup file and not an import inside each test: react-dom reads
 * __REACT_DEVTOOLS_GLOBAL_HOOK__ once at module evaluation, so a shim installed
 * from a test module can be too late — the exact ordering bug the production
 * first-import placement exists to avoid. Vitest evaluates setupFiles first.
 *
 * Why only the shim half: importing the observer here would evaluate the
 * telemetry module, and with it the real breadcrumb recorder, before any test
 * file's vi.mock could replace it.
 */
import { ensureReactDevtoolsCommitHook } from '../../src/renderer/src/lib/react-devtools-commit-hook-shim'

ensureReactDevtoolsCommitHook()
