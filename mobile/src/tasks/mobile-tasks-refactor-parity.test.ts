import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
 * baseline prove the diff renderer and the stylesheet never moved. Hook order
 * differs from the monolith in one place: useMobileTaskCopyFeedback moved two
 * positions later (index 123 to 125) so its setters and ref exist before it
 * runs; nothing between those points reads its result.
 *
 * PR file contents are the monolith's plain useState pair again, after the
 * bounded cache from #10179 was stripped. That trades three hook slots (two
 * useState, two useCallback clears, minus the cache hook) but restores the
 * monolith's load flow: cache-hit early return, loading path, try/catch/finally.
 * The render tree, declarations, and styles are unchanged by that swap.
 *
 * Declarations dropped from 196 to 195 when projectRowGitHubRepository was
 * deleted: it carried over from the monolith with no caller in either shape.
 *
 * Re-frozen when the monolith's `nameIsAutoManaged` computation was restored to the
 * workspace-create action (it had been dropped, so a typed workspace name was
 * discarded) and `toggleGitHubProjectFieldVisibility` went back to the monolith's
 * functional state updater. Both move the composition toward the baseline, not away:
 * one added statement, one changed callback body, no hook or declaration count change.
 */
const SCREEN_HOOKS = 'c5026e3f5633d36eae56f0492c5b239896f0b6d363079be1568de6460d7eae30'
const DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const STATEMENTS = '300258f651ed5aec07966cd4a382597ee21b381764aaa6222d18ce35b2600dd3'
const DECLARATIONS = '11ddb68df1bdde8ee3299bb391de14765e6860b8406d0c17f837223e3667bd13'
const SEMANTICS = '990736b2b2b450230fca06bb27ed97903d9827c59ad7e4c7be442a0d854f5750'
const STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const RENDER_TREE = '92596eb283232607d8c2df3f09ba970232c7df496555c6f59e0c7160a00501af'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(366)
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
    expect(declarations).toHaveLength(195)
    expect(hash(declarations)).toBe(DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_237)
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
    const route = readFileSync(
      resolve(import.meta.dirname, '../../app/h/[hostId]/tasks.tsx'),
      'utf8'
    )
    const body = route.slice(route.indexOf('export default function'))
    expect(route.split('\n').length).toBeLessThan(120)
    expect(body).not.toMatch(/\b(useState|useEffect|useMemo|useCallback|useRef)\(/)
    expect(body).not.toContain('sendRequest')
    expect(body).not.toContain('<View')
  })
})
