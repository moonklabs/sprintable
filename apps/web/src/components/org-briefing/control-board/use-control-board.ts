'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgentStates } from '@/hooks/use-agent-states';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import type { AgentStateRow } from '@/lib/agent-state-list';
import { grantKey, type BoardEpic, type BoardProject } from './derive-control-board';

/**
 * story 5033 (C3) — what the home's control board reads and writes. NOTHING NEW on the server's side of the placement: reading = `GET /api/agents/access-matrix` (an org owner/admin only — a 403 means «read only»),
 * writing = the very two calls the agent detail and the access matrix already make (`POST /api/projects/{pid}/access` · `DELETE /api/projects/{pid}/access/{record}`); the server decides every press.
 * 열외 = taking that access back (reversible by placing again) · 배치 = giving it. Never an org-wide switch-off.
 */

export type BoardOutcome = { kind: 'placed' | 'tookOut' | 'failed'; agentName: string; projectName: string } | null;

interface Loaded {
  projects: BoardProject[];
  epics: BoardEpic[];
  /** the agents that may be shown (active · not the system publisher); null = that read failed → every state row is shown */
  eligible: Set<string> | null;
  grants: Record<string, string> | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `/api/dashboard/overview` → the epics with their project (the field story 5033 added to the server's list) */
export function parseOverviewEpics(json: unknown): BoardEpic[] {
  const root = asRecord(json);
  const inner = asRecord(root?.data) ?? root;
  const list = asRecord(inner?.project_status)?.epics;
  if (!Array.isArray(list)) return [];
  const out: BoardEpic[] = [];
  for (const raw of list) {
    const e = asRecord(raw);
    if (!e || typeof e.status !== 'string') continue;
    out.push({
      projectId: typeof e.project_id === 'string' && e.project_id ? e.project_id : null,
      status: e.status,
      total: typeof e.total === 'number' ? e.total : 0,
      done: typeof e.done === 'number' ? e.done : 0,
    });
  }
  return out;
}

async function readJson(url: string): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetchWithAuth(url);
    return { status: res.status, json: res.ok ? await res.json().catch(() => null) : null };
  } catch {
    return null;
  }
}

function parseGrants(json: unknown): Record<string, string> {
  const rows = asRecord(json)?.data;
  const map: Record<string, string> = {};
  if (!Array.isArray(rows)) return map;
  for (const r of rows) {
    const row = asRecord(r);
    if (row && typeof row.agent_member_id === 'string' && typeof row.project_id === 'string' && typeof row.record_id === 'string') {
      map[grantKey(row.agent_member_id, row.project_id)] = row.record_id;
    }
  }
  return map;
}

export function useControlBoard() {
  const { rows, loaded: statesLoaded, readAt } = useAgentStates();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BoardOutcome>(null);
  const busyRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [projectsRes, overviewRes, membersRes, matrixRes] = await Promise.all([
      readJson('/api/projects'), readJson('/api/dashboard/overview'), readJson('/api/team-members?type=agent'), readJson('/api/agents/access-matrix'),
    ]);
    if (!projectsRes || projectsRes.status >= 400 || !Array.isArray(asRecord(projectsRes.json)?.data)) { setFailed(true); return; }
    const projects: BoardProject[] = (asRecord(projectsRes.json)!.data as unknown[]).flatMap((p) => {
      const r = asRecord(p);
      return r && typeof r.id === 'string' && typeof r.name === 'string' ? [{ id: r.id, name: r.name }] : [];
    });
    const memberRows = asRecord(membersRes?.json)?.data;
    const eligible = Array.isArray(memberRows)
      ? new Set(memberRows.flatMap((m) => {
        const r = asRecord(m);
        return r && typeof r.id === 'string' && r.is_active !== false && !isSystemPublisher(typeof r.runtime_type === 'string' ? r.runtime_type : null) ? [r.id] : [];
      }))
      : null;
    setFailed(false);
    setData({
      projects,
      epics: overviewRes && overviewRes.status < 400 ? parseOverviewEpics(overviewRes.json) : [],
      eligible,
      // 403 (not an org owner/admin) and any other failed read both mean «the placement is not known to this viewer» → read only; a write is never drawn from a guess
      grants: matrixRes && matrixRes.status < 400 && matrixRes.json !== null ? parseGrants(matrixRes.json) : null,
    });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const agents: AgentStateRow[] = useMemo(() => (data?.eligible ? rows.filter((r) => data.eligible!.has(r.agent_id)) : rows), [rows, data]);

  const rereadGrants = useCallback(async () => {
    const res = await readJson('/api/agents/access-matrix');
    if (res && res.status < 400 && res.json !== null) setData((d) => (d ? { ...d, grants: parseGrants(res.json) } : d));
  }, []);

  /** one press = one write (a second press while one is in flight is ignored) */
  const write = useCallback(async (kind: 'place' | 'takeOut', agent: { id: string; name: string }, project: BoardProject) => {
    const key = grantKey(agent.id, project.id);
    if (busyRef.current || !data?.grants) return;
    busyRef.current = key; setBusyKey(key); setOutcome(null);
    const fail = () => setOutcome({ kind: 'failed', agentName: agent.name, projectName: project.name });
    try {
      if (kind === 'place') {
        if (data.grants[key] !== undefined) return; // already placed — nothing to write
        const res = await fetchWithAuth(`/api/projects/${project.id}/access`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: agent.id, org_member_id: null, permission: 'granted' }),
        });
        if (res.ok) {
          const recordId = asRecord(asRecord(await res.json().catch(() => null))?.data)?.id;
          if (typeof recordId === 'string') setData((d) => (d?.grants ? { ...d, grants: { ...d.grants, [key]: recordId } } : d));
          else await rereadGrants();
          setOutcome({ kind: 'placed', agentName: agent.name, projectName: project.name });
        } else if (res.status === 409) { await rereadGrants(); } else fail();
      } else {
        const recordId = data.grants[key];
        if (recordId === undefined) return;
        const res = await fetchWithAuth(`/api/projects/${project.id}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setData((d) => { if (!d?.grants) return d; const next = { ...d.grants }; delete next[key]; return { ...d, grants: next }; });
          setOutcome({ kind: 'tookOut', agentName: agent.name, projectName: project.name });
        } else if (res.status === 404) { await rereadGrants(); } else fail();
      }
    } catch {
      fail(); // the network went away: said, never shown as done
    } finally {
      busyRef.current = null; setBusyKey(null);
    }
  }, [data, rereadGrants]);

  return {
    loaded: data !== null && statesLoaded,
    failed,
    retry: load,
    projects: data?.projects ?? [],
    epics: data?.epics ?? [],
    agents,
    grants: data?.grants ?? null,
    readAt,
    busyKey,
    outcome,
    place: (agent: { id: string; name: string }, project: BoardProject) => write('place', agent, project),
    takeOut: (agent: { id: string; name: string }, project: BoardProject) => write('takeOut', agent, project),
  };
}
