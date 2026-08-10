export function restartPairedHostClient(
  hostId: string,
  closeHost: (hostId: string) => void,
  forceReconnect: (hostId: string) => Promise<void>
): void {
  closeHost(hostId)
  void forceReconnect(hostId).catch(() => {})
}
