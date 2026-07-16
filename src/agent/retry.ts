/**
 * Detects transient connection/stream failures (dropped RPC streams, reset
 * sockets) that are safe to retry, as opposed to genuine denials or
 * permanent errors that should surface immediately.
 */
export const TRANSIENT_ERROR_PATTERN =
  /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|closed|disconnect|connection|stream/i;

export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | undefined)?.code ?? '';
  return TRANSIENT_ERROR_PATTERN.test(message) || TRANSIENT_ERROR_PATTERN.test(code);
}

export interface WithRetryOptions {
  attempts?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number) => void;
}

export async function withRetry<T>(op: () => Promise<T>, options: WithRetryOptions = {}): Promise<T> {
  const { attempts = 3, signal, onRetry } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }
    try {
      return await op();
    } catch (err) {
      if (attempt >= attempts || !isTransientError(err)) {
        throw err;
      }
      onRetry?.(attempt);
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error('unreachable');
}
