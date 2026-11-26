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
 *
 * Failing closed (codex 5958): the roster of agents (who may be shown — active, not the system publisher) must be read, else the board is an error with a retry (never «every state row»); the placement read
 * answers 403 = read only, any OTHER failure = an error with a retry (never passed off as «not an admin»); the epics' read failing = «progress unknown» (never «no goal in progress»).
 * A late answer of an old read (or after the board is gone — the shell keys the board by the organization) is dropped.
 */

export type BoardOutcome = { kind: 'placed' | 'tookOut' | 'placeFailed' | 'takeOutFailed'; agentName: string; projectName: string } | null;

interface Loaded {
  projects: BoardProject[];
  /** null = the read failed (progress unknown) */
  epics: BoardEpic[] | null;
  /** the agents that may be shown (active · not the system publisher) */
  eligible: Set<string>;
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
  const { rows, loaded: statesLoaded, readAt, failed: statesFailed } = useAgentStates();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BoardOutcome>(null);
  const busyRef = useRef<string | null>(null);
  const seq = useRef(0); // a newer read (or the board going away) makes an older answer stale

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [projectsRes, overviewRes, membersRes, matrixRes] = await Promise.all([
      readJson('/api/projects'), readJson('/api/dashboard/overview'), readJson('/api/team-members?type=agent'), readJson('/api/agents/access-matrix'),
    ]);
    if (mine !== seq.current) return;
    const projectRows = asRecord(projectsRes?.json)?.data;
    const memberRows = asRecord(membersRes?.json)?.data;
    const matrixReadable = matrixRes !== null && matrixRes.status < 400 && matrixRes.json !== null;
    const matrixForbidden = matrixRes?.status === 403;
    // fail closed: the project list, the roster and the placement read (403 aside) are all needed before any control is drawn
    if (!projectsRes || projectsRes.status >= 400 || !Array.isArray(projectRows) || !membersRes || membersRes.status >= 400 || !Array.isArray(memberRows) || (!matrixReadable && !matrixForbidden)) {
      setFailed(true);
      return;
    }
    const projects: BoardProject[] = projectRows.flatMap((p) => {
      const r = asRecord(p);
      return r && typeof r.id === 'string' && typeof r.name === 'string' ? [{ id: r.id, name: r.name }] : [];
    });
    const eligible = new Set(memberRows.flatMap((m) => {
      const r = asRecord(m);
      return r && typeof r.id === 'string' && r.is_active !== false && !isSystemPublisher(typeof r.runtime_type === 'string' ? r.runtime_type : null) ? [r.id] : [];
    }));
    setFailed(false);
    setData({
      projects,
      epics: overviewRes && overviewRes.status < 400 && overviewRes.json !== null ? parseOverviewEpics(overviewRes.json) : null,
      eligible,
      grants: matrixReadable ? parseGrants(matrixRes!.json) : null,
    });
  }, []);

  useEffect(() => {
    void load();
    return () => { seq.current += 1; }; // the board is gone: whatever answers late is dropped
  }, [load]);

  const agents: AgentStateRow[] = useMemo(() => (data ? rows.filter((r) => data.eligible.has(r.agent_id)) : []), [rows, data]);

  /** read the placement again; false = it could not be read (the caller says so — never a silent stale picture) */
  const rereadGrants = useCallback(async (): Promise<boolean> => {
    const res = await readJson('/api/agents/access-matrix');
    if (!res || res.status >= 400 || res.json === null) return false;
    setData((d) => (d ? { ...d, grants: parseGrants(res.json) } : d));
    return true;
  }, []);

  /** one press = one write (a second press while one is in flight is ignored) */
  const write = useCallback(async (kind: 'place' | 'takeOut', agent: { id: string; name: string }, project: BoardProject) => {
    const key = grantKey(agent.id, project.id);
    if (busyRef.current || !data?.grants || !data.eligible.has(agent.id)) return;
    busyRef.current = key; setBusyKey(key); setOutcome(null);
    const fail = () => setOutcome({ kind: kind === 'place' ? 'placeFailed' : 'takeOutFailed', agentName: agent.name, projectName: project.name });
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
          else if (!(await rereadGrants())) void load(); // placed, but the record id is unknown — read everything again
          setOutcome({ kind: 'placed', agentName: agent.name, projectName: project.name });
        } else if (res.status === 409) { if (!(await rereadGrants())) fail(); } else fail();
      } else {
        const recordId = data.grants[key];
        if (recordId === undefined) return;
        const res = await fetchWithAuth(`/api/projects/${project.id}/access/${recordId}`, { method: 'DELETE' });
        if (res.ok) {
          setData((d) => { if (!d?.grants) return d; const next = { ...d.grants }; delete next[key]; return { ...d, grants: next }; });
          setOutcome({ kind: 'tookOut', agentName: agent.name, projectName: project.name });
        } else if (res.status === 404) { if (!(await rereadGrants())) fail(); } else fail();
      }
    } catch {
      fail(); // the network went away: said, never shown as done
    } finally {
      busyRef.current = null; setBusyKey(null);
    }
  }, [data, rereadGrants, load]);

  return {
    loaded: data !== null && statesLoaded,
    // an error with a retry: our own reads failed, or the very first read of the agents' states failed (it is read again on its own every 30 s)
    failed: (data === null && failed) || (!statesLoaded && statesFailed === true),
    retry: load,
    projects: data?.projects ?? [],
    epics: data?.epics ?? null,
    agents,
    grants: data?.grants ?? null,
    readAt,
    busyKey,
    outcome,
    place: (agent: { id: string; name: string }, project: BoardProject) => write('place', agent, project),
    takeOut: (agent: { id: string; name: string }, project: BoardProject) => write('takeOut', agent, project),
  };
}
