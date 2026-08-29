import type { PreloadApi } from './api-types'
import type { PreloadApiImplementation } from './index'

/**
 * Compile-time proof that the preload bridge implements every member the
 * renderer is allowed to call.
 *
 * Why this is not redundant with the annotations in index.ts: `api` is handed to
 * `contextBridge.exposeInMainWorld`, which takes `any`, and the renderer types
 * every call as `PreloadApi` (api-types.ts). Nothing compared the two, so a
 * member declared in `PreloadApi` and never implemented reached the renderer as
 * `undefined` — and callers guard with `?.()`, which turns the absence into a
 * confident default rather than a failure.
 *
 * Names only, deliberately: `ipcRenderer.invoke` returns `Promise<unknown>`, so
 * full assignability reports pre-existing return-type widenings that the call
 * sites already cast. Presence is the half that fails silently.
 */
type AssertNoMissingMembers<Missing extends never> = Missing

type UnimplementedGroups = Exclude<keyof PreloadApi, keyof PreloadApiImplementation>

type UnimplementedMembers = {
  [Group in keyof PreloadApi & keyof PreloadApiImplementation]: Exclude<
    keyof PreloadApi[Group],
    keyof PreloadApiImplementation[Group]
  >
}[keyof PreloadApi & keyof PreloadApiImplementation]

export type PreloadApiGroupsAreImplemented = AssertNoMissingMembers<UnimplementedGroups>
export type PreloadApiMembersAreImplemented = AssertNoMissingMembers<UnimplementedMembers>
