export interface TeamMember {
  id: string;
  name: string;
  type: string;
  role: string;
  api_key?: string;
}

export interface Project {
  id: string;
  name: string;
}

async function apiFetch(
  apiUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = apiUrl.replace(/\/$/, "");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-agent-api-key": apiKey,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function ping(apiUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await apiFetch(apiUrl, apiKey, "/api/v2/ping");
    return res.ok;
  } catch {
    return false;
  }
}

export async function getProjects(apiUrl: string, apiKey: string): Promise<Project[]> {
  const res = await apiFetch(apiUrl, apiKey, "/api/v2/projects");
  if (!res.ok) throw new Error(`projects fetch failed: ${res.status}`);
  const data = (await res.json()) as { data?: Project[] } | Project[];
  return Array.isArray(data) ? data : (data.data ?? []);
}

export async function listTeamMembers(
  apiUrl: string,
  apiKey: string,
  projectId: string,
): Promise<TeamMember[]> {
  const res = await apiFetch(
    apiUrl,
    apiKey,
    `/api/v2/team-members?project_id=${projectId}`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { data?: TeamMember[] } | TeamMember[];
  return Array.isArray(data) ? data : (data.data ?? []);
}

export async function createTeamMember(
  apiUrl: string,
  apiKey: string,
  body: {
    project_id: string;
    org_id: string;
    type: "agent";
    name: string;
    role?: string;
  },
): Promise<TeamMember & { api_key?: string }> {
  const res = await apiFetch(apiUrl, apiKey, "/api/v2/team-members", {
    method: "POST",
    body: JSON.stringify({ role: "member", ...body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.status.toString());
    throw new Error(`team-member 생성 실패 (${res.status}): ${text}`);
  }
  return res.json() as Promise<TeamMember & { api_key?: string }>;
}

export async function getMe(
  apiUrl: string,
  apiKey: string,
): Promise<{ org_id: string; user_id: string } | null> {
  try {
    const res = await apiFetch(apiUrl, apiKey, "/api/v2/auth/me");
    if (!res.ok) return null;
    return res.json() as Promise<{ org_id: string; user_id: string }>;
  } catch {
    return null;
  }
}
