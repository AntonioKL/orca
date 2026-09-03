// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { Uri } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorTabs } from './closed-editor-tab-disposal'
import { toMonacoEditModelPath } from './monaco-edit-model-path'
import type { MonacoModelRegistry } from './diff-monaco-model-disposal'
import type { MonacoUriNamespace } from './monaco-edit-model-path'

// Why this exact shape: the field crash (`[UriError]: Scheme contains illegal characters.`) came
// from a Windows/WSL workspace. `Uri.parse` reads `\\wsl.localhost\...\notes` as the scheme
// because nothing before the first `:` is a `/`, `?` or `#`.
const WSL_COLON_PATH =
  '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\notes:2026.md'

type RecordingRegistry = MonacoModelRegistry & {
  Uri: MonacoUriNamespace
  disposed: string[]
}

function createRegistryWithRealUri(modelPaths: readonly string[]): RecordingRegistry {
  const disposed: string[] = []
  const modelsByUri = new Map<string, ReturnType<typeof createModel>>()

  function createModel(modelPath: string): {
    dispose: () => void
    isAttachedToEditor: () => boolean
    uri: { toString: (skipEncoding?: boolean) => string }
  } {
    const key = Uri.parse(modelPath).toString()
    return {
      dispose: () => disposed.push(modelPath),
      isAttachedToEditor: () => false,
      uri: { toString: () => key }
    }
  }

  for (const modelPath of modelPaths) {
    modelsByUri.set(Uri.parse(modelPath).toString(), createModel(modelPath))
  }

  return {
    disposed,
    Uri,
    editor: {
      getModel: (uri: unknown) => modelsByUri.get(String(uri)) ?? null,
      getModels: () => [...modelsByUri.values()]
    }
  }
}

function editTab(id: string, filePath: string): OpenFile {
  return { id, mode: 'edit', filePath } as OpenFile
}

describe('toMonacoEditModelPath', () => {
  it('leaves every path Monaco already accepts untouched', () => {
    for (const filePath of [
      '/home/mj/projects/acp-client/notes:2026.md',
      'C:\\Users\\mj\\notes:2026.md',
      '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\src\\index.ts'
    ]) {
      expect(toMonacoEditModelPath(Uri, filePath)).toBe(filePath)
    }
  })

  it('rewrites the path class that makes Monaco throw into a parseable one', () => {
    expect(() => Uri.parse(WSL_COLON_PATH)).toThrow(/Scheme contains illegal characters/)

    const modelPath = toMonacoEditModelPath(Uri, WSL_COLON_PATH)
    expect(modelPath).not.toBe(WSL_COLON_PATH)
    expect(() => Uri.parse(modelPath)).not.toThrow()
  })
})

describe('disposeClosedEditorTabs with the real Monaco URI parser', () => {
  it('does not throw the workbench down on the unparseable path class', () => {
    const registry = createRegistryWithRealUri([])

    expect(() =>
      disposeClosedEditorTabs(registry, [editTab('poisoned', WSL_COLON_PATH)])
    ).not.toThrow()
  })

  it('keeps disposing the rest of the close-all batch behind a poisoned tab', () => {
    const beforePath = '/repo/before.ts'
    const afterPath = '/repo/after.ts'
    const registry = createRegistryWithRealUri([
      beforePath,
      toMonacoEditModelPath(Uri, WSL_COLON_PATH),
      afterPath
    ])

    disposeClosedEditorTabs(registry, [
      editTab('before', beforePath),
      editTab('poisoned', WSL_COLON_PATH),
      editTab('after', afterPath)
    ])

    expect(registry.disposed).toContain(beforePath)
    expect(registry.disposed).toContain(afterPath)
    // Why: the poisoned tab's model is reachable too, because open and close now key it the same way.
    expect(registry.disposed).toContain(toMonacoEditModelPath(Uri, WSL_COLON_PATH))
  })
})
