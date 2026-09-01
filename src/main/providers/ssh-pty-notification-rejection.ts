import type { SshPtyRejectedSourceRecovery } from './ssh-pty-source-delivery-state'

export function rejectedRecoveryPriority(recovery: SshPtyRejectedSourceRecovery): number {
  if (recovery === 'reconnect-channel') {
    return 3
  }
  return recovery === 'fresh-activation' ? 2 : 1
}

export function rejectedSourceIdentity(params: {
  deliveryToken?: unknown
  clientGeneration?: unknown
  ownerGeneration?: unknown
  ptyIncarnation?: unknown
}):
  | Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>
  | undefined {
  if (
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration) ||
    typeof params.ptyIncarnation !== 'string' ||
    params.ptyIncarnation.length === 0
  ) {
    return undefined
  }
  return Object.freeze({
    deliveryToken: params.deliveryToken,
    clientGeneration: params.clientGeneration,
    ownerGeneration: params.ownerGeneration,
    ptyIncarnation: params.ptyIncarnation
  })
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
