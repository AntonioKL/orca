// Item-identity → stable journal key. Pure and shared: the host keys upserts
// with it and clients reconcile optimistic sends against the same string.
//
// Components are percent-encoded before joining so a value containing the
// delimiter cannot collide with a different identity.

import type { AgentJournalItemIdentity } from './agent-session-journal-types'

const KEY_DELIMITER = ':'

/** Longest raw component a key may embed. Real provider ids are tens of bytes;
 *  anything larger would push the composed key past wire page budgets, so it
 *  travels as a stable digest instead of verbatim. */
export const MAX_JOURNAL_KEY_COMPONENT_CHARS = 1024

/**
 * Deterministic stand-in for an oversized key component: same input, same
 * output, so revisions and tombstones of one identity still share a key, and
 * re-deriving from a parsed key is a fixed point (the bounded form is far
 * below the cap). The head keeps keys debuggable; length plus two independent
 * hashes makes an accidental collision practically impossible. Pure JS because
 * clients derive keys too and cannot reach node:crypto.
 */
export function boundJournalKeyComponent(value: string): string {
  if (value.length <= MAX_JOURNAL_KEY_COMPONENT_CHARS) {
    return value
  }
  const h1 = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, '0')
  const h2 = fnv1a32(value, 0x0100_0193).toString(16).padStart(8, '0')
  return `${codePointBoundedHead(value, 40)}~orca-oversized~${value.length}~${h1}${h2}`
}

/** `slice` cuts UTF-16 code units, so a head ending mid-astral-character would
 *  carry a lone high surrogate and make `encodeURIComponent` throw on a valid
 *  id. Dropping that unit keeps the head valid Unicode and deterministic. */
function codePointBoundedHead(value: string, maxUnits: number): string {
  const head = value.slice(0, maxUnits)
  const last = head.charCodeAt(head.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x0100_0193) >>> 0
  }
  return hash >>> 0
}

function encodePart(value: string | number): string {
  return encodeURIComponent(boundJournalKeyComponent(String(value)))
}

/**
 * Stable string key for an item identity.
 *
 * Codex renumbers `item-N` ids on every resume, so its key is the thread, the
 * turn, and the item's ordinal WITHIN that turn — a position that survives
 * renumbering because a completed turn's item list does not change. `thread/fork`
 * copies turns keeping their original turn ids, so the thread id must stay in the
 * key. Claude copies item uuids on `--fork-session`, so its key is the session id
 * plus the uuid. Text never participates.
 */
export function agentJournalItemKey(identity: AgentJournalItemIdentity): string {
  if (identity.provider === 'codex') {
    return [
      'codex',
      encodePart(identity.threadId),
      encodePart(identity.turnId),
      encodePart(identity.ordinal)
    ].join(KEY_DELIMITER)
  }
  if (identity.provider === 'claude') {
    return ['claude', encodePart(identity.sessionId), encodePart(identity.uuid)].join(KEY_DELIMITER)
  }
  if (identity.provider === 'orca') {
    return ['orca', encodePart(identity.clientMessageId)].join(KEY_DELIMITER)
  }
  return [
    'legacy',
    encodePart(identity.agent),
    encodePart(identity.sessionId),
    encodePart(identity.recordId)
  ].join(KEY_DELIMITER)
}

/** Key for the pre-dispatch submission placeholder, before any provider echo. */
export function agentJournalSubmissionKey(clientMessageId: string): string {
  return agentJournalItemKey({ provider: 'orca', clientMessageId })
}

/**
 * Inverse of {@link agentJournalItemKey}. Clients hold item KEYS, but an upsert
 * needs the identity behind one — answering an approval re-appends the same
 * item at the next revision. Every component is percent-encoded, and
 * `encodeURIComponent` escapes the delimiter, so the split is unambiguous.
 */
export function parseAgentJournalItemKey(key: string): AgentJournalItemIdentity | null {
  const parts = key.split(KEY_DELIMITER).map((part) => decodeURIComponent(part))
  const [provider, ...rest] = parts
  if (provider === 'codex' && rest.length === 3) {
    const ordinal = Number(rest[2])
    return Number.isSafeInteger(ordinal) && ordinal >= 0
      ? { provider, threadId: rest[0] as string, turnId: rest[1] as string, ordinal }
      : null
  }
  if (provider === 'claude' && rest.length === 2) {
    return { provider, sessionId: rest[0] as string, uuid: rest[1] as string }
  }
  if (provider === 'orca' && rest.length === 1) {
    return { provider, clientMessageId: rest[0] as string }
  }
  if (provider === 'legacy' && rest.length === 3) {
    return {
      provider,
      agent: rest[0] as string,
      sessionId: rest[1] as string,
      recordId: rest[2] as string
    }
  }
  return null
}
