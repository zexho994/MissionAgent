export interface RetryOptions {
  maxAttempts: number;
  delaysMs: number[];
  onRetry?: (info: { attempt: number; error: unknown; nextDelayMs: number }) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === options.maxAttempts - 1;
      if (isLastAttempt) {
        break;
      }

      const delayMs = options.delaysMs[attempt] ?? 0;
      options.onRetry?.({ attempt: attempt + 1, error, nextDelayMs: delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
