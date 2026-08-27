import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const guidePath = join(projectDir, 'skill-guides', 'orchestration.md')
const referenceRoot = join(projectDir, 'skill-guides', 'orchestration', 'references')
const stubPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

function readKernel() {
  return readFileSync(guidePath, 'utf8')
}

function readReference(name) {
  return readFileSync(join(referenceRoot, name), 'utf8')
}

function frontmatter(text) {
  return /^---\n[\s\S]*?\n---\n/u.exec(text)?.[0]
}

function squash(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

describe('orchestration kernel', () => {
  it('keeps the always-loaded guide compact and ordered around the normal protocol', () => {
    const kernel = readKernel()
    const headings = [
      '## Outcome',
      '## Classify the role',
      '## Authority and safety floor',
      '## Worker obligations',
      '## Canonical supervised loop',
      '## Task-spec contract',
      '## Completion accounting',
      '## Conditional references'
    ]

    expect(kernel.split('\n').length).toBeLessThanOrEqual(200)
    for (let index = 1; index < headings.length; index += 1) {
      expect(kernel.indexOf(headings[index])).toBeGreaterThan(kernel.indexOf(headings[index - 1]))
    }
    expect(kernel).not.toContain('## Contract Migration')
    expect(kernel).not.toContain('## Full Handoffs')
    expect(kernel).not.toContain('## Worker Terminals')
  })

  it('classifies coordinator, dispatched worker, handoff, compatibility, and ordinary roles', () => {
    const kernel = readKernel()

    expect(kernel).toContain('explicitly asks to supervise, monitor, wait for results')
    expect(kernel).toContain('live injected preamble with Task and Dispatch IDs')
    expect(kernel).toContain('Handoff owner')
    expect(kernel).toContain('create no Run, Task, or Dispatch and do not monitor completion')
    expect(kernel).toContain('Compatibility operator')
    expect(kernel).toContain('Ordinary terminal agent')
    expect(kernel).toContain('Model or effort selection does not make a handoff supervised')
    expect(kernel).toContain('Never substitute a\nnon-Orca subagent tool')
  })

  it('makes Dispatch identity, remote uncertainty, folders, and mixed versions a safety floor', () => {
    const kernel = readKernel()

    expect(kernel).toContain('A Dispatch is one authoritative Task attempt')
    expect(kernel).toContain('Lifecycle authority comes from the active Dispatch')
    expect(kernel).toContain('execution host owns')
    expect(kernel).toContain('`live` / `unverifiable` / `exited`')
    expect(kernel).toContain('contact loss is not process death')
    expect(kernel).toContain('Folder workspaces are valid')
    expect(kernel).toContain('Treat unknown optional fields\n  as absent')
    expect(kernel).toContain('new stream operation requires advertised capability')
    expect(kernel).toContain('Never fall back to local execution')
  })

  it('puts exactly-once worker completion and post-completion idle before coordinator mechanics', () => {
    const kernel = readKernel()

    expect(kernel.indexOf('## Worker obligations')).toBeLessThan(
      kernel.indexOf('## Canonical supervised loop')
    )
    expect(kernel).toContain('The injected preamble is authoritative')
    expect(kernel).toContain('Send `worker_done` exactly once')
    expect(kernel).toContain('three-sentence executive summary')
    expect(kernel).toContain('`--outcome succeeded` or `--outcome failed`')
    expect(kernel).toContain('--dispatch-capability <capability>')
    expect(kernel).toContain('--task-id <task_id> --dispatch-id <dispatch_id>')
    expect(kernel).toContain('After `worker_done`, end the dispatched turn and idle')
    expect(kernel).toContain('Do not reuse the settled lifecycle IDs')
  })

  it('teaches worker-start as the only normal-path launch and starts the wave before waiting', () => {
    const kernel = readKernel()
    const firstStart = kernel.indexOf('worker-start --task <task_a>')
    const secondStart = kernel.indexOf('worker-start --task <task_b>')
    const firstWait = kernel.indexOf('check --wait')

    expect(firstStart).toBeGreaterThan(kernel.indexOf('run-create'))
    expect(secondStart).toBeGreaterThan(firstStart)
    expect(firstWait).toBeGreaterThan(secondStart)
    expect(kernel).toContain('start the full independent wave before waiting')
    expect(kernel).toContain('`worker-start` is the normal path')
    expect(kernel).toContain('operator-created process unsupervised')
    expect(kernel).not.toMatch(/^ORCA terminal create/mu)
  })

  it('requires full Delivery processing and settled-terminal accounting before ack', () => {
    const kernel = readKernel()

    expect(kernel).toContain('oldest FIFO Delivery and replays that\nbatch until acknowledged')
    expect(kernel).toContain('Process every message')
    expect(kernel).toContain("decide each\nsettled terminal's next owner before acknowledging")
    expect(squash(kernel)).toContain('reused, explicitly retained, or released')
    expect(kernel).toContain('worker-release --dispatch <dispatch_id>')
    expect(kernel).toContain('check --ack <delivery_id> --wait')
    expect(kernel).toContain('Do not follow\nit with `task-update --status completed`')
  })

  it('treats long waits and release uncertainty as safe checkpoints', () => {
    const kernel = readKernel()

    expect(kernel).toContain('A timeout or empty result is\na checkpoint, not a failure')
    expect(kernel).toContain('Do not stop, retry, release, or launch a duplicate\neditor')
    expect(kernel).toContain('Never release because of\nidle state, timeout, heartbeat')
    expect(kernel).toContain('never substitute `terminal close`')
  })

  it('defines self-contained task specs and honest send attention semantics', () => {
    const kernel = readKernel()

    for (const field of [
      '**Target:**',
      '**Change:**',
      '**Constraints:**',
      '**Ownership:**',
      '**Observable acceptance:**'
    ]) {
      expect(kernel).toContain(field)
    }
    expect(kernel).toContain('successful `orchestration send` proves durable enqueue')
    expect(kernel).toContain('best-effort attention only')
    expect(kernel).toContain('does not prove the recipient read the message')
  })
})

describe('owned orchestration references', () => {
  it('routes every conditional read to exactly one shipped reference', () => {
    const kernel = readKernel()
    const routed = [...kernel.matchAll(/`references\/([^`]+\.md)`/gu)].map((match) => match[1])
    const shipped = readdirSync(referenceRoot)
      .filter((name) => name.endsWith('.md'))
      .sort()

    expect([...new Set(routed)].sort()).toEqual(shipped)
    expect(routed).toHaveLength(shipped.length)
    expect(kernel).toContain('ORCA skills get orchestration --full')
    expect(kernel).toContain(
      'returns this exact kernel and every reference from\nthe same CLI build'
    )
    expect(kernel).toContain('If an older CLI rejects\n`--full`')
  })

  it('owns expanded waves, launch preferences, reuse, and review boundaries', () => {
    const reference = readReference('coordinator-loop.md')

    expect(reference).toContain('task-list --ready --brief --json')
    expect(reference).toContain('`--effort` requires `--model`')
    expect(reference).toContain('neither option combines with `--terminal`')
    expect(reference).toContain('`launch.requested` with `launch.effective`')
    expect(reference).toContain('worker-start --task <next_task_id> --terminal')
    expect(reference).toContain('A review-only `worker_done` authorizes synthesis')
    expect(reference).toContain('post-review fixes and\nPR preparation remain with that owner')
  })

  it('owns worker heartbeat, ask resume, escalation, failure, and idle', () => {
    const reference = readReference('worker-contract.md')

    expect(reference).toContain('--type heartbeat')
    expect(reference).toContain('--task-id <task_id> --dispatch-id <dispatch_id>')
    expect(reference).toContain('--phase "<investigating|implementing|reviewing|waiting>"')
    expect(reference).toContain('--resume <message_id>')
    expect(reference).toContain('do not create a duplicate question')
    expect(reference).toContain('--type escalation')
    expect(reference).toContain('Send exactly one terminal report')
    expect(reference).toContain('Use `--outcome failed`')
    expect(reference).toContain('After `worker_done`, end the dispatched turn and idle')
  })

  it('keeps heartbeat and worker_done recipes bound to the injected capability', () => {
    const reference = readReference('worker-contract.md')
    const recipes = [...reference.matchAll(/```text\n([\s\S]*?)```/gu)].map((match) => match[1])
    const heartbeat = recipes.find((recipe) => recipe.includes('--type heartbeat'))
    const workerDone = recipes.find((recipe) => recipe.includes('--type worker_done'))

    for (const recipe of [heartbeat, workerDone]) {
      expect(recipe).toContain('--from <worker_handle>')
      expect(recipe).toContain('--dispatch-capability <capability>')
      expect(recipe).toContain('--task-id <task_id> --dispatch-id <dispatch_id>')
    }
    expect(workerDone).not.toContain('--files-modified')
    expect(workerDone).not.toContain('--report-path')
    expect(reference).toContain('only when applicable, using actual\npaths')
    expect(reference).toContain('Do not send documentation placeholders as metadata')
  })

  it('owns local, folder, worktree, SSH, WSL, remote, and mixed-version placement', () => {
    const reference = readReference('placement-and-remote.md')

    expect(reference).toContain('--worktree current --agent codex')
    expect(reference).toContain('--worktree new-child')
    expect(reference).toContain('--worktree new-top-level')
    expect(reference).toContain('Folder workspaces are first-class')
    expect(reference).toContain('Remote `current` and `new-child` are invalid')
    expect(reference).toContain("`--on` selects\nonly the worker's execution server")
    expect(reference).toContain('route every follow-up, read,\nstop, and cleanup by Dispatch ID')
    expect(reference).toContain('`live`, `unverifiable`, or `exited`')
    expect(reference).toContain('unknown stream\nopcodes can be silently dropped')
    expect(reference).toContain('printed `orca-ide`')
  })

  it('owns FIFO mail, Dispatch addresses, groups, questions, and gates', () => {
    const reference = readReference('messaging-and-gates.md')

    expect(reference).toContain('oldest FIFO Delivery')
    expect(reference).toContain('Process\nevery row')
    expect(reference).toContain('send --to dispatch:<dispatch_id>')
    for (const group of ['@all', '@grok', '@cursor', '@worktree:<id>']) {
      expect(reference).toContain(group)
    }
    expect(reference).toContain('Dispatch lifecycle messages never target groups')
    expect(reference).toContain('gate-create --task <task_id>')
    expect(reference).toContain("Do not create a gate merely to answer a worker's `ask`")
    expect(reference).toContain('successful `send` proves durable enqueue')
    expect(reference).toContain('Wake and nudge are best-effort\nattention only')
  })

  it('owns positive-evidence retry, unknown outcomes, retain/release, and no terminal close', () => {
    const reference = readReference('recovery-and-cleanup.md')

    expect(squash(reference)).toContain('| `ready` or active | Keep waiting')
    expect(squash(reference)).toContain('| `outcome_unknown` | Inspect')
    expect(squash(reference)).toContain('| Remote contact lost | Preserve `unverifiable`')
    expect(reference).toContain('--retry-of <dispatch_id>')
    expect(reference).toContain('Placement is never\nsilently inherited')
    expect(reference).toContain('worker-abandon --dispatch')
    expect(reference).toContain('worker-retain --dispatch')
    expect(reference).toContain('worker-release --dispatch')
    expect(reference).toContain('`release_pending`\nor `release_unknown`')
    expect(reference).toContain('Never substitute\n`terminal close`')
  })

  it('owns the custom topology exception without claiming process ownership', () => {
    const reference = readReference('low-level-topology.md')

    expect(reference).toContain('only when `worker-start` cannot express')
    expect(reference).toContain('terminal create --worktree active')
    expect(reference).toContain('dispatch --task <task_id> --to <handle> --inject')
    expect(reference).toContain('operator-created process unsupervised')
    expect(reference).toContain('creates no supervised worker\nresource row')
    expect(reference).toContain('Use `worker-start --terminal <handle>`')
    expect(reference).toContain('never\nuse it for an ownership handoff')
  })

  it('owns legacy labels, read-only degradation, exact recovery, and takeover', () => {
    const reference = readReference('legacy-contract-migration.md')

    expect(reference).toContain('[LEGACY COMPATIBILITY]')
    expect(reference).toContain('[LEGACY RECOVERY REPLAY — MAY HAVE BEEN SEEN]')
    expect(reference).toContain('[LEGACY READ-ONLY]')
    expect(reference).toContain(
      'degrade to\nread-only inspection and never fall back to local execution'
    )
    expect(reference).toContain(
      'must not spawn, write, signal, stop, switch, focus, split, or\ninject'
    )
    expect(reference).toContain('launcher status `75`')
    expect(reference).toContain('run_legacy_local')
    expect(reference).toContain('Recovered orchestration work from a contract update')
    expect(reference).toContain('run-use --id <adopted_run_id> --takeover-legacy')
    expect(reference).toContain(
      'Never take over while the original coordinator is actively coordinating'
    )
  })
})

describe('orchestration install stub', () => {
  it('preserves the safe version-matched resolver and bounded old-binary fallback', () => {
    const stub = readFileSync(stubPath, 'utf8')

    expect(stub).toContain('discovery stub')
    expect(stub).toContain('ORCA skills get orchestration')
    expect(stub).toContain('ORCA_CLI_COMMAND')
    expect(stub).toContain('orca-dev')
    expect(stub).toContain('orca-ide')
    expect(stub).toContain('GNOME Orca screen reader')
    expect(squash(stub)).toContain('explicitly reports that `skills get` is an unknown command')
    expect(stub).toContain('do not invent commands')
    expect(stub).not.toMatch(/^orca /mu)
  })

  it('performs no orchestration mutation before loading the guide', () => {
    const stub = readFileSync(stubPath, 'utf8')
    const preGuide = stub.split('## Load the full guide')[0]

    expect(preGuide).not.toContain('orchestration task-create')
    expect(preGuide).not.toContain('orchestration dispatch')
    expect(frontmatter(stub)).toBe(frontmatter(readKernel()))
    expect(stub.length).toBeLessThan(readKernel().length)
  })
})
