import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

/**
 * Every Windows-gated test file must be registered in BOTH Windows-lane lists.
 *
 * PR CI has exactly one `windows-2022` job, and it runs a curated explicit file
 * list. Everything else runs on `ubuntu-latest`, where a Windows-gated suite
 * self-skips and reports success. So a new Windows-gated file that nobody
 * registers executes on no machine and passes green, silently. A recent
 * security effort added six such files; five ran nowhere, including one whose
 * whole point was asserting a native addon's bytes no longer contain a flagged
 * primitive. Registering the instances did not hold -- a sixth arrived from
 * unrelated work while the first five were being fixed -- so the class needs a
 * guard.
 *
 * Both lists matter and being in one is not enough: `WINDOWS_PACKAGE_TESTS` in
 * pr-code-change-scope.mjs decides whether the `package_windows` job RUNS at
 * all for a diff, and the workflow step's vitest argv decides whether the FILE
 * runs once the job started.
 *
 * WHAT THIS DETECTS -- a file is Windows-gated when its name is `*.win32.test.*`
 * / `*.win32.spec.*`, or when it contains a suite-level gate spelled any of:
 *   - `describe.runIf(process.platform === 'win32')`
 *   - `describe.skipIf(process.platform !== 'win32')`
 *   - `describe.runIf(isWindows)` / `describe.skipIf(!isWindows)`, for a local
 *     `const isWindows`/`IS_WINDOWS`/`isWin32` truthy-on-Windows flag
 *   - `const d = process.platform === 'win32' ? describe : describe.skip`
 *   - `const d = process.platform !== 'win32' ? describe.skip : describe`
 * Quote style, spacing and the `describe`/`suite` spelling are all tolerated.
 *
 * WHAT THIS CANNOT DETECT -- known blind spots, each deliberate:
 *   - `it`/`test`-level gates inside an otherwise cross-platform suite. Those
 *     files still run their remaining cases on ubuntu, and pulling every one of
 *     them into the serial Windows job is not the trade CI wants.
 *   - a gate whose condition is computed indirectly (a helper call, an env var,
 *     an imported `describeOnWindows`, an `isWindows` that is itself defined as
 *     `platform !== 'win32'`). Nothing in the repo does this today.
 *   - a registered path that is spelled correctly but gated for some OTHER
 *     platform, and a suite gated on Windows *plus* a second condition that is
 *     false in CI. Registration is asserted, execution is not.
 *   - whether the Windows job itself is triggered for a given diff, whether the
 *     `windows-2022` runner exists, or whether the registered test asserts
 *     anything. This guard is about registration only.
 */

const projectDir = resolve(import.meta.dirname, '../..')
const WINDOWS_LANE_JOB = 'package_windows'
const WINDOWS_LANE_STEP = 'Test Windows-specific boundaries'

/**
 * Windows-gated files that predate this guard and are registered in neither
 * list. Shrink-only: registering one means deleting its line here. Never add.
 */
const UNREGISTERED_ON_MAIN = [
  // Suite gated with `describe.skipIf(platform !== 'win32')`; the cross-platform
  // half of the file still runs on ubuntu, the Windows half runs nowhere.
  'src/main/antigravity/windows-hook-payload-delivery.test.ts',
  // `.win32.test.ts` by name yet in neither list -- the plainest instance of the class.
  'src/main/daemon/node-pty-windows-input-error.win32.test.ts',
  // Same shape as the antigravity file: a win32-only sibling suite that never runs.
  'src/main/grok/windows-grok-hook-script.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/ipc/preflight-windows-path-refresh.repro.test.ts',
  // Nested `describe.skipIf(!isWindows)` real-shell block; never exercised in CI.
  'src/main/ipc/pty-encoding.test.ts',
  // `describeWindows` ternary over the whole file; runs on no machine.
  'src/main/providers/windows-shell-preflight-runtime.windows.test.ts',
  // Whole file is `describe.runIf(platform === 'win32')`; runs on no machine.
  'src/main/startup/windows-shell-path-restoration.windows.test.ts',
  // Whole file is `describe.skipIf(platform !== 'win32')`; runs on no machine.
  'src/shared/setup-agent-sequencing.windows.test.ts'
]

/**
 * Floor for the Windows-gated population, so a broken walk or a regex that
 * stops matching cannot make the guard pass by finding nothing. Only ever
 * lowered, and only when a gated file is genuinely deleted.
 */
const GATED_FILE_FLOOR = 13

/**
 * This file quotes every gate spelling as a fixture, so it matches its own
 * matcher. It is not gated -- it must run on ubuntu, since a guard about
 * Windows CI that only ran on Windows would be self-defeating. Exempt by exact
 * path, never by directory, so a real gated file in config/scripts is caught.
 */
const SCANNER_SELF_PATH = 'config/scripts/win32-test-lane-registration.test.mjs'

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|mjs|cjs|js)$/
const WIN32_FILENAME_PATTERN = /\.win32\.(?:test|spec)\./
const SCAN_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.git',
  '.turbo'
])

// Truthy on Windows / truthy off Windows. Kept as source strings so the two
// halves of every gate spelling below stay in one place.
const WIN32_TRUE = String.raw`(?:process\.platform\s*===\s*['"]win32['"]|isWindows(?!\s*[(:])|IS_WINDOWS|isWin32)`
const WIN32_FALSE = String.raw`(?:process\.platform\s*!==\s*['"]win32['"]|!\s*(?:isWindows|IS_WINDOWS|isWin32))`
const SUITE = String.raw`(?:describe|suite)`

/**
 * Why `(?!\s*\.\s*skip)` on the ternary: the inverted spelling
 * `platform === 'win32' ? describe.skip : describe` is the POSIX-only gate, and
 * seven files in this repo use it. Matching it would flag the exact opposite of
 * the class.
 */
const WIN32_SUITE_GATES = [
  new RegExp(String.raw`\b${SUITE}\s*\.\s*runIf\s*\(\s*${WIN32_TRUE}\s*\)`),
  new RegExp(String.raw`\b${SUITE}\s*\.\s*skipIf\s*\(\s*${WIN32_FALSE}\s*\)`),
  new RegExp(String.raw`=\s*${WIN32_TRUE}\s*\?\s*${SUITE}\s*(?!\s*\.\s*skip)`),
  new RegExp(String.raw`=\s*${WIN32_FALSE}\s*\?\s*${SUITE}\s*\.\s*skip`)
]

/** Exported shape of the rule, so the fixtures below exercise the real matcher. */
export function isWindows32GatedTestFile(path, source) {
  if (WIN32_FILENAME_PATTERN.test(path)) {
    return true
  }
  return WIN32_SUITE_GATES.some((gate) => gate.test(source))
}

function collectTestFiles(root) {
  let found = []
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (SCAN_IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      found = found.concat(collectTestFiles(full))
      continue
    }
    if (TEST_FILE_PATTERN.test(entry)) {
      found.push(full)
    }
  }
  return found
}

function toRepoPath(absolute) {
  return relative(projectDir, absolute).split('\\').join('/')
}

/** The vitest argv of the one Windows job's one curated-file step. */
function readWindowsLaneFiles() {
  const workflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))
  const steps = workflow.jobs?.[WINDOWS_LANE_JOB]?.steps ?? []
  const step = steps.find((candidate) => candidate?.name === WINDOWS_LANE_STEP)
  if (!step) {
    throw new Error(
      `No "${WINDOWS_LANE_STEP}" step in the ${WINDOWS_LANE_JOB} job of .github/workflows/pr.yml. ` +
        'If it was renamed, update WINDOWS_LANE_STEP here -- do not delete this guard.'
    )
  }
  const run = String(step.run ?? '')
  if (!run.includes('vitest run')) {
    throw new Error(
      `The "${WINDOWS_LANE_STEP}" step no longer invokes vitest; this guard is stale.`
    )
  }
  return run.split(/\s+/).filter((token) => TEST_FILE_PATTERN.test(token))
}

const laneFiles = readWindowsLaneFiles()
const scannedTestFiles = collectTestFiles(projectDir).map(toRepoPath)
const gatedFiles = scannedTestFiles
  .filter((path) => path !== SCANNER_SELF_PATH)
  .filter((path) => isWindows32GatedTestFile(path, readFileSync(join(projectDir, path), 'utf8')))

function isInClassifier(path) {
  return classifyPrJobs([path])[WINDOWS_LANE_JOB] === true
}

function registrationFailure(path) {
  const missing = []
  if (!laneFiles.includes(path)) {
    missing.push(
      `add "${path}" to the "${WINDOWS_LANE_STEP}" vitest argv in .github/workflows/pr.yml ` +
        `(job ${WINDOWS_LANE_JOB})`
    )
  }
  if (!isInClassifier(path)) {
    missing.push(
      `add '${path}' to WINDOWS_PACKAGE_TESTS in config/scripts/pr-code-change-scope.mjs`
    )
  }
  return missing.length === 0 ? null : `${path}: ${missing.join('; and ')}`
}

describe('Windows-gated test files are registered in the Windows CI lane', () => {
  it('scans a plausible number of test files', () => {
    // A broken root or extension filter would make every assertion below vacuous.
    expect(scannedTestFiles.length).toBeGreaterThan(5000)
  })

  it('parses a plausible Windows lane invocation', () => {
    expect(laneFiles.length).toBeGreaterThan(15)
    const missingFromDisk = laneFiles.filter((path) => {
      try {
        return !statSync(join(projectDir, path)).isFile()
      } catch {
        return true
      }
    })
    expect(
      missingFromDisk,
      'The Windows lane invokes vitest on paths that do not exist -- vitest will run nothing for them.'
    ).toEqual([])
  })

  it('rediscovers Windows-gated files that are already registered', () => {
    // Both discovery paths, proven against real files rather than fixtures: one
    // found by filename plus ternary alias, one found only by its gate
    // expression because its name says nothing about Windows gating.
    expect(gatedFiles).toContain('src/shared/child-process/windows-command-line.win32.test.ts')
    expect(gatedFiles).toContain('src/main/agent-hooks/windows-hook-payload-delivery.test.ts')
  })

  it('exempts itself, and nothing else, from the scan', () => {
    expect(scannedTestFiles).toContain(SCANNER_SELF_PATH)
    const self = readFileSync(join(projectDir, SCANNER_SELF_PATH), 'utf8')
    // The exemption is load-bearing only while the fixtures below still match.
    expect(isWindows32GatedTestFile(SCANNER_SELF_PATH, self)).toBe(true)
    expect(gatedFiles).not.toContain(SCANNER_SELF_PATH)
  })

  it('holds the Windows-gated population at or above the floor', () => {
    // Bounding by the debt list's length would be trivially true -- the two move
    // together. The floor is a literal for that reason.
    expect(
      gatedFiles.length,
      `Found ${gatedFiles.length} Windows-gated test files; the floor is ${GATED_FILE_FLOOR}. ` +
        'A drop means the scan stopped matching, not that the files went away. Lower the floor ' +
        'only for a genuine deletion.'
    ).toBeGreaterThanOrEqual(GATED_FILE_FLOOR)
  })

  it('confirms the classifier distinguishes registered from unregistered paths', () => {
    // Without this, a classifier that answered true for everything would make
    // the registration assertion below pass for free.
    expect(isInClassifier('src/main/windows/windows-pty-job.win32.test.ts')).toBe(true)
    expect(isInClassifier('src/main/windows/not-a-real-file.win32.test.ts')).toBe(false)
  })

  it('has every Windows-gated test file in both registration lists', () => {
    const failures = gatedFiles
      .filter((path) => !UNREGISTERED_ON_MAIN.includes(path))
      .map(registrationFailure)
      .filter((failure) => failure !== null)
    expect(
      failures,
      'A Windows-gated test file is missing from a Windows CI registration list. It self-skips on ' +
        'ubuntu and reports success, so it runs on no machine. Both lists are required: ' +
        'WINDOWS_PACKAGE_TESTS decides whether the package_windows job runs for a diff, the ' +
        'workflow argv decides whether the file runs once it started. Fix each line below.'
    ).toEqual([])
  })

  it('has no stale entry in the pre-existing-debt list', () => {
    const stale = UNREGISTERED_ON_MAIN.filter(
      (path) => !gatedFiles.includes(path) || registrationFailure(path) === null
    )
    expect(
      stale,
      'These files are no longer unregistered Windows-gated debt -- they were registered, ' +
        'renamed, un-gated, or deleted. Delete each line from UNREGISTERED_ON_MAIN; the list ' +
        'only ever shrinks.'
    ).toEqual([])
  })
})

describe('Windows-gate detection', () => {
  // Each positive is paired with the near-miss it must reject. The pairs are
  // written from the shapes that exist in the repo, not from the regexes above.
  const cases = [
    [
      'describe.runIf equality',
      "describe.runIf(process.platform === 'win32')('x', () => {})",
      "describe.runIf(process.platform !== 'win32')('x', () => {})"
    ],
    [
      'describe.skipIf inequality',
      "describe.skipIf(process.platform !== 'win32')('x', () => {})",
      "describe.skipIf(process.platform === 'win32')('x', () => {})"
    ],
    [
      'ternary describe alias',
      "const d = process.platform === 'win32' ? describe : describe.skip",
      "const d = process.platform === 'win32' ? describe.skip : describe"
    ],
    [
      'inverted ternary describe alias',
      "const d = process.platform !== 'win32' ? describe.skip : describe",
      "const d = process.platform !== 'win32' ? describe : describe.skip"
    ],
    [
      'local isWindows flag',
      'describe.skipIf(!isWindows)("x", () => {})',
      'describe.skipIf(isWindows)("x", () => {})'
    ],
    [
      'local isWindows flag, runIf',
      'describe.runIf(isWindows)("x", () => {})',
      'describe.runIf(!isWindows)("x", () => {})'
    ],
    [
      'double-quoted and loosely spaced',
      'describe . runIf ( process.platform === "win32" )("x", () => {})',
      'describe . runIf ( process.platform === "darwin" )("x", () => {})'
    ]
  ]

  for (const [label, gated, nearMiss] of cases) {
    it(`detects ${label} and rejects its near miss`, () => {
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', gated)).toBe(true)
      expect(isWindows32GatedTestFile('src/x/sample.test.ts', nearMiss)).toBe(false)
    })
  }

  it('detects the .win32 filename with no gate expression at all', () => {
    expect(isWindows32GatedTestFile('src/x/sample.win32.test.ts', 'describe("x", () => {})')).toBe(
      true
    )
    // Near miss: `.win32.ts` is production source, not a test the lane can run.
    expect(isWindows32GatedTestFile('src/x/sample.win32.ts', 'export const x = 1')).toBe(false)
  })

  it('rejects the documented blind spots rather than half-detecting them', () => {
    // it-level gate inside a cross-platform suite: out of scope by design.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "describe('x', () => { it.skipIf(process.platform !== 'win32')('y', () => {}) })"
      )
    ).toBe(false)
    // A platform branch inside a test body is not a gate.
    expect(
      isWindows32GatedTestFile(
        'src/x/sample.test.ts',
        "it('x', () => { if (process.platform === 'win32') { return } })"
      )
    ).toBe(false)
  })
})
