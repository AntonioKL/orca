import AsyncStorage from '@react-native-async-storage/async-storage'

const WATERMARK_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsWatermark:'
// Pre-#8591 installs wrote the seq alone. Read once to migrate; never written.
const LEGACY_SEQ_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsLastSeq:'

type WatermarkPersistenceState = {
  revision: number
  tail: Promise<void>
  desired: PersistedWatermark | null
  repairRevision: number | null
  inFlightStorageOperations: number
  pendingOperations: number
}

// Timed-out native IO detaches; a late completion repairs the latest requested revision.
const persistenceByHost = new Map<string, WatermarkPersistenceState>()

function getPersistenceState(hostId: string): WatermarkPersistenceState {
  let state = persistenceByHost.get(hostId)
  if (!state) {
    state = {
      revision: 0,
      tail: Promise.resolve(),
      desired: null,
      repairRevision: null,
      inFlightStorageOperations: 0,
      pendingOperations: 0
    }
    persistenceByHost.set(hostId, state)
  }
  return state
}

function watermarkStorageKey(hostId: string): string {
  return WATERMARK_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
}

export type PersistedWatermark = { seq: number; epoch: string | null }
export type LoadedWatermark = PersistedWatermark & { stored: boolean }

const WATERMARK_IO_TIMEOUT_MS = 2_000

function settleWithin(promise: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, WATERMARK_IO_TIMEOUT_MS)
    void promise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function persistWatermark(
  hostId: string,
  watermark: PersistedWatermark | null
): Promise<void> {
  if (watermark) {
    try {
      await AsyncStorage.setItem(watermarkStorageKey(hostId), JSON.stringify(watermark))
    } catch {}
    return
  }
  await Promise.all([
    removeStorageItem(watermarkStorageKey(hostId)),
    removeStorageItem(LEGACY_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId))
  ])
}

async function removeStorageItem(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key)
  } catch {}
}

function releaseSettledClear(hostId: string, state: WatermarkPersistenceState): void {
  if (
    state.desired === null &&
    state.repairRevision === null &&
    state.inFlightStorageOperations === 0 &&
    state.pendingOperations === 0 &&
    persistenceByHost.get(hostId) === state
  ) {
    persistenceByHost.delete(hostId)
  }
}

function scheduleCurrentWatermarkRepair(hostId: string, state: WatermarkPersistenceState): void {
  const revision = state.revision
  if (state.repairRevision === revision) {
    return
  }
  state.repairRevision = revision
  const repair = queueWatermarkPersistence(hostId, state, revision, state.desired)
  void repair.completed.then(() => {
    if (state.repairRevision === revision) {
      state.repairRevision = null
    }
    if (state.revision !== revision) {
      scheduleCurrentWatermarkRepair(hostId, state)
    }
    releaseSettledClear(hostId, state)
  })
}

function queueWatermarkPersistence(
  hostId: string,
  state: WatermarkPersistenceState,
  revision: number,
  watermark: PersistedWatermark | null
): { settled: Promise<void>; completed: Promise<void> } {
  let enteredStorage = false
  state.pendingOperations += 1
  const completed = state.tail.then(async () => {
    if (revision !== state.revision) {
      return
    }
    enteredStorage = true
    state.inFlightStorageOperations += 1
    try {
      await persistWatermark(hostId, watermark)
    } finally {
      state.inFlightStorageOperations -= 1
    }
  })
  const settled = settleWithin(completed)
  state.tail = settled
  void completed.then(() => {
    state.pendingOperations -= 1
    if (enteredStorage && revision !== state.revision) {
      scheduleCurrentWatermarkRepair(hostId, state)
    }
    releaseSettledClear(hostId, state)
  })
  return { settled, completed }
}

function coerceSeq(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export async function loadWatermark(hostId: string): Promise<LoadedWatermark> {
  try {
    const raw = await AsyncStorage.getItem(watermarkStorageKey(hostId))
    if (raw != null) {
      const parsed = JSON.parse(raw) as { seq?: unknown; epoch?: unknown }
      const epoch =
        typeof parsed.epoch === 'string' && parsed.epoch.length > 0 ? parsed.epoch : null
      return { seq: coerceSeq(parsed.seq), epoch, stored: true }
    }
  } catch {
    // Unreadable or malformed: fall through to the legacy key rather than throw.
  }
  try {
    const legacy = await AsyncStorage.getItem(
      LEGACY_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
    )
    return { seq: coerceSeq(legacy), epoch: null, stored: legacy != null }
  } catch {
    return { seq: 0, epoch: null, stored: false }
  }
}

export async function clearWatermark(hostId: string): Promise<void> {
  const state = getPersistenceState(hostId)
  state.revision += 1
  state.desired = null
  await queueWatermarkPersistence(hostId, state, state.revision, null).settled
}

export async function saveWatermark(hostId: string, watermark: PersistedWatermark): Promise<void> {
  const state = getPersistenceState(hostId)
  state.revision += 1
  state.desired = watermark
  await queueWatermarkPersistence(hostId, state, state.revision, watermark).settled
}

export function resetWatermarkPersistenceForTests(): void {
  persistenceByHost.clear()
}
