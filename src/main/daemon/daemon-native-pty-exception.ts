const NATIVE_PTY_ERROR_CODE_PATTERN = /\b(?:EIO|EPIPE|EBADF|ENXIO|EAGAIN)\b/

export function isNativePtyException(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'Error') {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  return /\bpty\b/i.test(error.message) || NATIVE_PTY_ERROR_CODE_PATTERN.test(code ?? error.message)
}
