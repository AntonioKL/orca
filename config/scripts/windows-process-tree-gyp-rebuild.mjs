/**
 * Where and how `@vscode/windows-process-tree` is rebuilt from source.
 *
 * node-gyp must run from the package's physical directory, never the
 * `node_modules` symlink/junction pnpm installs there: gyp expands the
 * node-addon-api dependency by probing node (whose cwd resolves to the
 * physical path), gets back a store-relative `../../../../node-addon-api@…`
 * hop, then resolves that hop against the rebuild cwd. From the link path the
 * hop escapes the store and configure fails with "node_addon_api.gyp not
 * found" (run 32999886072).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')

export const WINDOWS_PROCESS_TREE_PACKAGE_DIR = join(
  ROOT,
  'node_modules',
  '@vscode',
  'windows-process-tree'
)

export const WINDOWS_PROCESS_TREE_PATCH_PATH = join(
  ROOT,
  'config',
  'patches',
  '@vscode__windows-process-tree@0.8.0.patch'
)

/** Only the patched reader defines this; the upstream one walks the PEB. */
const COMMAND_LINE_PATCH_MARKER = 'kProcessCommandLineInformation'

export const WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS = [
  'napi.h',
  'napi-inl.h',
  'napi-inl.deprecated.h'
]

export function nodeGypRebuildInvocation(arch, packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR) {
  return {
    args: [
      join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
      'rebuild',
      `--arch=${arch}`
    ],
    cwd: realpathSync(packageDir)
  }
}

/**
 * Refuse to compile the upstream command-line reader.
 *
 * Unpatched, it opens every process with `PROCESS_VM_READ` and walks the PEB
 * with `ReadProcessMemory` to recover the command line -- the primitive MDE
 * scores as credential dumping, and the reason this package is patched at all.
 * pnpm has been seen materializing this CRLF package with its patch missing, so
 * repair from the patch file rather than silently building the flagged reader.
 */
export function ensureWindowsProcessTreeCommandLinePatch(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const source = join(packageDir, 'src', 'process_commandline.cc')
  if (readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
    return false
  }
  try {
    execFileSync(
      'git',
      ['apply', '--include=src/process_commandline.cc', WINDOWS_PROCESS_TREE_PATCH_PATH],
      { cwd: realpathSync(packageDir), stdio: 'pipe' }
    )
  } catch (error) {
    throw new Error(
      `src/process_commandline.cc still reads the PEB with ReadProcessMemory, and repairing it from ` +
        `${WINDOWS_PROCESS_TREE_PATCH_PATH} failed: ${error?.message ?? error}. Run pnpm install.`
    )
  }
  if (!readFileSync(source, 'utf8').includes(COMMAND_LINE_PATCH_MARKER)) {
    throw new Error(
      'src/process_commandline.cc still reads the PEB with ReadProcessMemory after repair. ' +
        'Run pnpm install.'
    )
  }
  return true
}

// Patched binding.gyp includes deps/node-addon-api; the tarball does not ship those headers.
export function stageWindowsProcessTreeNodeAddonApiHeaders(
  packageDir = WINDOWS_PROCESS_TREE_PACKAGE_DIR
) {
  const nodeAddonApiDir = dirname(
    createRequire(join(packageDir, 'package.json')).resolve('node-addon-api/package.json')
  )
  const stagedHeaderDir = join(packageDir, 'deps', 'node-addon-api')
  mkdirSync(stagedHeaderDir, { recursive: true })
  for (const header of WINDOWS_PROCESS_TREE_NODE_ADDON_API_HEADERS) {
    copyFileSync(join(nodeAddonApiDir, header), join(stagedHeaderDir, header))
  }
  return stagedHeaderDir
}
