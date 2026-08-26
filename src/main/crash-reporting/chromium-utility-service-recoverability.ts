// Chromium spawns utility services on demand and tears them down as routine
// churn, so an allowlist of them can only ever be behind: 1.4.188 filed the PAC
// evaluator and the print compositor as user-facing crashes because neither was
// enumerated, and the PAC report even collected a user note about a 14 MB JSON
// file it had nothing to do with. We cannot enumerate Chromium's service list,
// but we can enumerate the services whose death is ours to answer for, so the
// default inverts and the exceptions below carry the enumeration.
const NON_RECOVERABLE_UTILITY_SERVICE_NAMES = new Set([
  // Electron's utilityProcess.fork() host: this is our own code dying, not Chromium's.
  'node.mojom.NodeService',
  // Backs durable profile storage, so an exit can mean real user data loss.
  'storage.mojom.StorageService'
])

// Mojo service names are `<module>.mojom.<Interface>`; anything else is not a
// Chromium-owned service and has to keep reporting.
const CHROMIUM_MOJO_SERVICE_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*\.mojom\.[A-Za-z0-9_]+$/

/**
 * Whether a `child-process-gone` utility exit is routine Chromium churn.
 *
 * Suppression is breadcrumb-only: the exit still lands in the durable trail as
 * `process_gone_suppressed`, and #15251 observes it as a sibling death before
 * classification runs, so a utility that took a renderer down still names itself
 * in that renderer's report. What is dropped is the user-facing crash prompt and
 * the minidump signature, so deny a service here whenever we would need
 * post-mortem detail to act on its death.
 *
 * An absent service name is *not* evidence of Chromium ownership — we did not
 * observe who died — so it keeps reporting.
 */
export function isRecoverableChromiumUtilityService(serviceName: string | undefined): boolean {
  if (serviceName === undefined || NON_RECOVERABLE_UTILITY_SERVICE_NAMES.has(serviceName)) {
    return false
  }
  return CHROMIUM_MOJO_SERVICE_NAME.test(serviceName)
}
