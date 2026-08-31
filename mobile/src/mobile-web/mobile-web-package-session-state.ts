import type { MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'

export type MobileWebPackageSession = {
  session: MobileWebShellSession | null
  sessionHostId: string | undefined
  viewEpoch: number
  packageLoading: boolean
  packageProgress: MobileWebPackageDownloadProgress | undefined
  packageWarning: string | undefined
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
  showWarning: (warning: string) => void
}
