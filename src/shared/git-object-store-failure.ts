/**
 * Classify "Git cannot read an object it needs" failures and turn them into a
 * message a user can act on.
 *
 * Why this exists: `git worktree add` resolves the branch tip from the ref
 * database but reads the *tree* from the object database, so a repo whose commit
 * object survives while its tree does not passes every commit-only preflight and
 * then dies inside the checkout. Orca cannot prevent that (the damage is
 * environment-side: filtered clone, interrupted fetch, gc/repack race, disk
 * corruption), so the failure path has to name it and say how to repair it.
 *
 * Lives in shared/ because the classifier must run on the client: the raw text
 * can also arrive from an older relay host that never wrapped it.
 */

export type GitObjectStoreFailureKind =
  | 'unreadable-tree'
  | 'unparsable-commit'
  | 'missing-object'
  | 'corrupt-object'

export type GitObjectStoreFailure = {
  kind: GitObjectStoreFailureKind
  oid: string | null
}

/** Stable phrase both the host message and the client formatter key off. */
export const GIT_OBJECT_STORE_FAILURE_ANCHOR = 'repository object database is missing objects'

const OID = '[0-9a-f]{7,64}'

// Why ordered: an unreadable tree is the specific shape `worktree add` dies on, and
// its wording ("unable to read tree") would otherwise be swallowed by the generic
// missing-object patterns below.
const FAILURE_PATTERNS: readonly { kind: GitObjectStoreFailureKind; pattern: RegExp }[] = [
  // git's tree-walk.c die() prints the oid it was asked to dereference; the parenthesised
  // form is what newer Git emits, the bare form is what 2.44 and friends emit.
  { kind: 'unreadable-tree', pattern: new RegExp(`unable to read tree\\s*\\(?(${OID})\\)?`, 'i') },
  { kind: 'unreadable-tree', pattern: /unable to read tree/i },
  // The sparse create path dies in the follow-up `git checkout`, not in `worktree add
  // --no-checkout`, and checkout words the same missing root tree as a commit it cannot
  // parse (verbatim on git 2.44.0). The commit object itself is usually intact.
  {
    kind: 'unparsable-commit',
    pattern: new RegExp(`unable to parse commit(?:\\s+(${OID}))?`, 'i')
  },
  { kind: 'corrupt-object', pattern: new RegExp(`object file .*? is empty`, 'i') },
  { kind: 'corrupt-object', pattern: new RegExp(`loose object (${OID}).*? is corrupt`, 'i') },
  { kind: 'corrupt-object', pattern: /unable to unpack .*? header/i },
  {
    kind: 'missing-object',
    pattern: new RegExp(`missing (?:blob|tree|commit|tag) object '?(${OID})'?`, 'i')
  },
  { kind: 'missing-object', pattern: new RegExp(`unable to read (${OID})`, 'i') },
  { kind: 'missing-object', pattern: new RegExp(`could not read object (${OID})`, 'i') },
  { kind: 'missing-object', pattern: new RegExp(`object not found:? (${OID})`, 'i') },
  { kind: 'missing-object', pattern: /did not send all necessary objects/i },
  { kind: 'missing-object', pattern: /promisor-remote: unable to fetch/i }
]

export function classifyGitObjectStoreFailure(text: string): GitObjectStoreFailure | null {
  if (!text) {
    return null
  }
  for (const { kind, pattern } of FAILURE_PATTERNS) {
    const match = text.match(pattern)
    if (match) {
      return { kind, oid: match[1] ?? null }
    }
  }
  return null
}

export type GitObjectPresence = 'present' | 'missing' | 'unverifiable'
export type PartialCloneVerdict = 'yes' | 'no' | 'unverifiable'

export type GitObjectStoreFailureReport = {
  failure: GitObjectStoreFailure
  /** Branch or ref the checkout was for; the user's own name, not a filesystem path. */
  branch: string
  commit: GitObjectPresence
  rootTree: GitObjectPresence
  partialClone: PartialCloneVerdict
}

// Why rebuilt rather than echoed: git's stderr reaches us glued to `Command failed: git
// worktree add <absolute path> <branch>`, and re-emitting any of it is how the user's
// home directory and full argv ended up in bug reports. Only kind + oid survive.
function describeGitReport(failure: GitObjectStoreFailure): string {
  if (failure.kind === 'corrupt-object') {
    return failure.oid
      ? `a corrupt object file for ${failure.oid}`
      : 'a corrupt or truncated object file'
  }
  if (failure.kind === 'unreadable-tree') {
    return failure.oid ? `unable to read tree (${failure.oid})` : 'unable to read tree'
  }
  if (failure.kind === 'unparsable-commit') {
    return failure.oid ? `unable to parse commit ${failure.oid}` : 'unable to parse a commit'
  }
  return failure.oid ? `missing object ${failure.oid}` : 'a missing object'
}

export function formatGitObjectStoreFailureMessage(report: GitObjectStoreFailureReport): string {
  const sentences = [
    `Orca could not create this workspace because the ${GIT_OBJECT_STORE_FAILURE_ANCHOR}.`,
    `Git reported: ${describeGitReport(report.failure)}.`
  ]

  // Both halves need their own evidence: a failed `^{tree}` peel is equally what an
  // unreadable COMMIT produces, so without a commit sighting neither claim is observed.
  if (report.commit === 'present' && report.rootTree === 'missing') {
    sentences.push(
      `The commit for "${report.branch}" is present but its root tree object is missing, so Git could not check any files out.`
    )
  } else {
    sentences.push(`Git could not read every object the checkout of "${report.branch}" needs.`)
  }

  if (report.partialClone === 'yes') {
    sentences.push(
      'This repository is a partial clone, so those objects were meant to be downloaded lazily from its promisor remote; run git fetch (git fetch --refetch on Git 2.36 or newer) to refill them.'
    )
  }

  sentences.push(GIT_OBJECT_STORE_REPAIR_GUIDANCE)

  return sentences.join(' ')
}

/**
 * Trailing repair sentence, kept in the host-composed message so logs stay self-contained
 * and split back out by the client so the toast can show the short title instead.
 */
// No blanket "Orca did not do this": Orca runs `git worktree prune` on several removal paths
// and leaves Git's auto-maintenance (gc.auto) enabled on ordinary fetches, so it cannot promise
// nothing of its doing touched the object store. Keep this purely actionable.
export const GIT_OBJECT_STORE_REPAIR_GUIDANCE =
  'Run git fsck in the repository to confirm what is missing, then re-fetch from the remote or re-clone to restore it.'

export function splitGitObjectStoreRepairGuidance(message: string): {
  summary: string
  repair: string
} {
  const index = message.indexOf(GIT_OBJECT_STORE_REPAIR_GUIDANCE)
  return index === -1
    ? { summary: message, repair: GIT_OBJECT_STORE_REPAIR_GUIDANCE }
    : // Why slice to the end, not the constant: callers append after it (the sparse
      // rollback's "cleanup also failed" note), and dropping that loses the only place
      // the user is told a half-created worktree is still on disk.
      { summary: message.slice(0, index).trimEnd(), repair: message.slice(index) }
}

export function isGitObjectStoreFailureMessage(message: string): boolean {
  return message.toLowerCase().includes(GIT_OBJECT_STORE_FAILURE_ANCHOR)
}

/**
 * True only when Git answered a lookup "no" and nothing else.
 *
 * The load-bearing distinction for every object probe: `rev-parse --verify --quiet`
 * (and `config --get-regexp`) report a genuine absence with a *wordless* status 1, but
 * an object that is present-and-unopenable also fails — sometimes with the same status 1
 * after printing `error: unable to open loose object <oid>: Permission denied`, and on
 * some versions with status 128 instead. Status alone therefore cannot tell "absent"
 * from "unreadable", and a probe that skips this check turns "we could not read it" into
 * "it is gone". Pinned against the real-binary matrix in git-binary-compatibility.test.ts.
 */
export function isGitSilentNegativeAnswer(exitStatus: unknown, output: string): boolean {
  return exitStatus === 1 && !/^(?:error|fatal):/m.test(output)
}

const DIAGNOSIS_OPENING = 'Orca could not create this workspace because the'

// Electron's ipcRenderer.invoke rebuilds the rejection as a string instead of preserving the
// Error, so a host-composed diagnosis reaches the renderer behind transport text.
const TRANSPORT_ENVELOPE = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/

/** Drop the transport wrapper so a host-composed diagnosis is rendered as the host wrote it. */
export function unwrapGitObjectStoreFailureMessage(message: string): string {
  const opening = message.indexOf(DIAGNOSIS_OPENING)
  return opening > 0 ? message.slice(opening) : message.replace(TRANSPORT_ENVELOPE, '')
}
