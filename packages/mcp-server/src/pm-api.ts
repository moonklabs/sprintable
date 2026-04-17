/**
 * pmApi — lightweight HTTP helper for calling the Sprintable PM API.
 *
 * All MCP tools that need PM resources should go through this layer
 * instead of calling Supabase directly.
 */

export class PmApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'PmApiError';
  }
}

let _pmApiUrl: string;
let _agentApiKey: string;

/**
 * Call once at startup to configure the module-level credentials.
 * Throws if either value is missing.
 */
export function configurePmApi(pmApiUrl: string, agentApiKey: string): void {
  if (!pmApiUrl) throw new Error('PM_API_URL is required');
  if (!agentApiKey) throw new Error('AGENT_API_KEY is required');
  _pmApiUrl = pmApiUrl.replace(/\/$/, ''); // strip trailing slash
  _agentApiKey = agentApiKey;
}

export type PmApiInit = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
};

/**
 * Make an authenticated request to the Sprintable PM API.
 *
 * @param path  API path starting with `/` (e.g. `/api/docs?project_id=…`)
 * @param init  Standard fetch init (method, body, etc.)
 * @returns     Parsed response body
 * @throws      {PmApiError} on non-2xx responses
 */
export async function pmApi<T = unknown>(path: string, init: PmApiInit = {}): Promise<T> {
  const url = `${_pmApiUrl}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${_agentApiKey}`,
    'Content-Type': 'application/json',
    ...init.headers,
  };

  const response = await fetch(url, { ...init, headers });

  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { /* ignore */ }
    const message =
      (body as { error?: { message?: string; } } | undefined)?.error?.message ??
      (body as { error?: string } | undefined)?.error ??
      `PM API ${response.status}`;
    throw new PmApiError(response.status, String(message), body);
  }

  const json = (await response.json()) as { data?: T };
  return json.data as T;
}
