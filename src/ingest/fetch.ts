const DEFAULT_USER_AGENT = 'JingkanIngest/0.1 (+https://github.com/lzz313/jingkan-ingest)';

export interface FetchOptions {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Discard a failed response body so the connection can be reused. */
async function discard(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* A consumed body is already released. */ }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 25_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(900 * attempt);
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers.set(key, value);
    }
    if (!headers.has('user-agent')) headers.set('user-agent', DEFAULT_USER_AGENT);
    if (!headers.has('accept')) headers.set('accept', '*/*');

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    await discard(response);
    const error = new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    // A 403/404 (or any other non-retryable 4xx) will not change on a retry;
    // fail fast instead of sleeping through the remaining attempts.
    if (!retryable) throw error;
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await fetchWithRetry(url, {}, options);
  return response.text();
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithRetry(
    url,
    { headers: { accept: 'application/json' } },
    options,
  );
  return (await response.json()) as T;
}
