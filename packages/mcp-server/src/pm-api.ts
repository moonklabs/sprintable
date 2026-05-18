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
let _memberId: string = '';
let _orgId: string = '';
let _projectId: string = '';

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

/**
 * Call after configurePmApi() to resolve member_id/org_id/project_id from the API Key.
 * Caches the result in module-level variables for use in request body injection.
 */
export async function resolveAuthContext(): Promise<{ memberId: string; orgId: string; projectId: string }> {
  const res = await pmApi<{ member_id: string; org_id: string | null; project_id: string | null }>('/api/v2/auth/me');
  _memberId = res.member_id ?? '';
  _orgId = res.org_id ?? '';
  _projectId = res.project_id ?? '';
  return { memberId: _memberId, orgId: _orgId, projectId: _projectId };
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
    'x-agent-api-key': _agentApiKey,
    'Content-Type': 'application/json',
    ...init.headers,
  };

  // POST/PUT/PATCH body에 context 필드 자동 주입 (Next.js 프록시 제거 후 누락 필드 보완)
  if (
    init.method &&
    ['POST', 'PUT', 'PATCH'].includes(init.method) &&
    typeof init.body === 'string'
  ) {
    try {
      const parsed = JSON.parse(init.body);
      if (!parsed.project_id && _projectId) parsed.project_id = _projectId;
      if (!parsed.created_by && _memberId) parsed.created_by = _memberId;
      if (!parsed.org_id && _orgId) parsed.org_id = _orgId;
      init = { ...init, body: JSON.stringify(parsed) };
    } catch { /* body가 JSON이 아닌 경우 원본 유지 */ }
  }

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

  const json = await response.json();
  // {data: T} 래핑 형식이면 .data, 아니면 직접 반환 (배열 등)
  if (json !== null && typeof json === 'object' && !Array.isArray(json) && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}
