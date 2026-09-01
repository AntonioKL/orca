import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  readFlattenedMobileTasksHookSignatures,
  readMobileTasksSemanticSource,
  readMobileTasksStyleSource
} from './mobile-tasks-source-family.test-support'
import { readFlattenedMobileTasksRenderTokens } from './mobile-tasks-render-parity.test-support'
import {
  readFlattenedMobileTasksCoreStatements,
  readMobileTasksDeclarationSignatures
} from './mobile-tasks-execution-parity.test-support'

const hash = (parts: string[] | string): string =>
  createHash('sha256')
    .update(Array.isArray(parts) ? parts.join('\n') : parts)
    .digest('hex')

/**
 * Baseline: the single-file Tasks screen that preceded the hook composition.
 * Every statement, render token, and style below was compared against that file
 * before these digests were frozen; statements and render tokens matched it
 * exactly, and the two digests carried over unchanged from the pre-split
 * baseline prove the diff renderer and the stylesheet never moved.
 */
const SCREEN_HOOKS = '2e7b6ef35be986914ea8ee2bd23bca2b991f763e4417dbcc51e3d30483b318e5'
const DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const STATEMENTS = 'c55e439bb35a4596f24858ae8999bfc032991fbe08e6df3c1c4748cc451946ae'
const DECLARATIONS = 'c2937abd0fbb8aa40093a1cf3f1c8a4a7e1acc8a7fe66de390a8e5fb259dc61b'
const SEMANTICS = 'f12d9e4f73f7fee67eafe986f3fcef20482e76707e11fd306a288e1e7bf90557'
const STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const RENDER_TREE = '92596eb283232607d8c2df3f09ba970232c7df496555c6f59e0c7160a00501af'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(363)
    expect(hash(screenHooks)).toBe(SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(439)
    expect(hash(statements)).toBe(STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(196)
    expect(hash(declarations)).toBe(DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_232)
    expect(hash(semantics)).toBe(SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_290)
    expect(hash(tokens)).toBe(RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(STYLES)
  })

  it('keeps the route a thin composition over the stage hooks', () => {
    const route = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(route.every((entry) => !entry.startsWith('useMobileTasks'))).toBe(true)
  })
})
