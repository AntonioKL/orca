import { rejectValuelessFlag } from './flags'
import { RuntimeClientError } from './runtime/types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `--retry-request` carries the mutation identity that makes a replay idempotent. A damaged value
 * must never fall through to `undefined`, because the client would then mint a fresh identity and
 * re-apply a mutation that may already have taken effect (#15180).
 */
export function readRetryRequestFlag(flags: Map<string, string | boolean>): string | undefined {
  const value = flags.get('retry-request')
  rejectValuelessFlag(value, 'retry-request')
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--retry-request must be the UUID Orca reported for the original request; pass it exactly as printed, or omit the flag to start a new request.'
    )
  }
  return value
}
