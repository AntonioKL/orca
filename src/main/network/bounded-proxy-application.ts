const PROXY_APPLICATION_ATTEMPTS = 2

export async function runBoundedProxyApplication<T>(apply: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < PROXY_APPLICATION_ATTEMPTS; attempt += 1) {
    try {
      return await apply()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
