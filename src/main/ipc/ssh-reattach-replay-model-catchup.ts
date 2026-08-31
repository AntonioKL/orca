import { parseAppSshPtyId } from '../providers/ssh-pty-id'

type HeadlessCatchUpRuntime = {
  hasHeadlessTerminal: (ptyId: string) => boolean
  appendHeadlessTerminalCatchUp: (ptyId: string, data: string, fence: number) => boolean
}

export type PtyModelIngestFence = {
  readonly ptyId: string
  readonly sequence: number
  consumed?: boolean
}

export function applySshReattachReplayModelCatchUp(args: {
  runtime: HeadlessCatchUpRuntime | null | undefined
  ptyId: string
  isReattach: boolean
  replay: string | undefined
  replayUnseenChars: number | undefined
  seededFromReplay: boolean
  modelIngestFence: PtyModelIngestFence | null | undefined
}): boolean {
  const { replay, replayUnseenChars: unseen, modelIngestFence: fence } = args
  if (
    !args.isReattach ||
    !replay ||
    args.seededFromReplay ||
    !args.runtime ||
    unseen === undefined ||
    unseen <= 0 ||
    unseen > replay.length ||
    !fence ||
    fence.consumed === true ||
    fence.ptyId !== args.ptyId ||
    parseAppSshPtyId(args.ptyId) === null ||
    !args.runtime.hasHeadlessTerminal(args.ptyId)
  ) {
    return false
  }
  fence.consumed = true
  return args.runtime.appendHeadlessTerminalCatchUp(
    args.ptyId,
    replay.slice(-unseen),
    fence.sequence
  )
}
