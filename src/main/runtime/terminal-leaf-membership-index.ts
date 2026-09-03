import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'

type LayoutsByTabId = Record<string, TerminalLayoutSnapshot>

type LeafMembershipIndex = {
  /** First tab (in record order) whose layout tree holds the leaf — matches the linear scan. */
  readonly tabIdByLeafId: ReadonlyMap<string, string>
  /** Root nodes the index was built from; absent tab reads back `undefined`, empty tab `null`. */
  readonly builtFrom: ReadonlyMap<string, TerminalPaneLayoutNode | null>
}

const EMPTY_INDEX: LeafMembershipIndex = {
  tabIdByLeafId: new Map(),
  builtFrom: new Map()
}

// Sessions hand back the same layouts record across reads, so one index serves every lookup.
const indexByLayoutsRecord = new WeakMap<LayoutsByTabId, LeafMembershipIndex>()

function addLeafIds(
  node: TerminalPaneLayoutNode | null | undefined,
  tabId: string,
  tabIdByLeafId: Map<string, string>
): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    if (!tabIdByLeafId.has(node.leafId)) {
      tabIdByLeafId.set(node.leafId, tabId)
    }
    return
  }
  addLeafIds(node.first, tabId, tabIdByLeafId)
  addLeafIds(node.second, tabId, tabIdByLeafId)
}

/**
 * Why an identity check and not just the WeakMap: a few writers copy the layouts record and then
 * assign into the copy, so the record can be new while most layout objects are shared — and a
 * cached index must not outlive a replaced layout. Comparing root references is O(tabs) pointer
 * loads with no allocation, versus the rebuild's set-per-tab tree walk.
 *
 * Why the ROOT and not the layout object: `persistPtyBinding` grafts a leaf by assigning
 * `layout.root` on the same layout object inside the same record (see the split/first-root branches
 * in `persistence/loading-store/pty-binding-persistence.ts`), so a layout-identity check would keep
 * serving an index that has never seen the grafted leaf. Membership is a pure function of the root
 * tree, and no writer mutates a node in place, so root identity is the exact revalidation key.
 */
function isIndexCurrent(index: LeafMembershipIndex, layouts: LayoutsByTabId): boolean {
  let seen = 0
  for (const tabId of Object.keys(layouts)) {
    const builtFromRoot = index.builtFrom.get(tabId)
    if (builtFromRoot === undefined || builtFromRoot !== (layouts[tabId]?.root ?? null)) {
      return false
    }
    seen += 1
  }
  return seen === index.builtFrom.size
}

function buildIndex(layouts: LayoutsByTabId): LeafMembershipIndex {
  const tabIdByLeafId = new Map<string, string>()
  const builtFrom = new Map<string, TerminalPaneLayoutNode | null>()
  for (const tabId of Object.keys(layouts)) {
    const root = layouts[tabId]?.root ?? null
    builtFrom.set(tabId, root)
    addLeafIds(root, tabId, tabIdByLeafId)
  }
  return { tabIdByLeafId, builtFrom }
}

/** leafId -> owning tabId for one session's layouts, rebuilt only when a layout object changes. */
export function getTerminalLeafMembershipIndex(
  layouts: LayoutsByTabId | undefined
): ReadonlyMap<string, string> {
  if (!layouts) {
    return EMPTY_INDEX.tabIdByLeafId
  }
  const cached = indexByLayoutsRecord.get(layouts)
  if (cached && isIndexCurrent(cached, layouts)) {
    return cached.tabIdByLeafId
  }
  const built = buildIndex(layouts)
  indexByLayoutsRecord.set(layouts, built)
  return built.tabIdByLeafId
}
