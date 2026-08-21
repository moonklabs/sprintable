'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

// story #2852(2836 FE 조각, BE PR#3266) — TeamPresencePanel은 ScrollShell(전역)에 항상 마운트돼
// 있어(org-briefing 진입과 무관) 「인증 실패」 뱃지에 필요한 원자료를 자체적으로 확보해야 한다.
// derive-now-face.ts의 RawAttentionItem 전체 파싱은 org-briefing 전용 스코프(project_id 등
// 무관 필드까지 요구)라 이 훅에선 agent_auth_failure 항목만 가볍게 직접 뽑는다(중복 파서
// 아님 — 필요한 필드 4개만 보는 얇은 별도 파서, org-briefing 파서와 결합 시 원치 않는 결합만
// 생김).
export interface AgentAuthFailureInfo {
  reason: 'expired' | 'revoked' | 'invalid';
  failureCount: number;
}

const REFRESH_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `/api/dashboard/my-actions` attention.items[]에서 agent_auth_failure만 골라 member_id 키 맵으로. */
export function parseAgentAuthFailures(json: unknown): Record<string, AgentAuthFailureInfo> {
  const inner = isRecord(json) ? (json['data'] ?? json) : json;
  const attentionObj = isRecord(inner) && isRecord(inner['attention']) ? (inner['attention'] as Record<string, unknown>) : null;
  const itemsRaw = attentionObj ? attentionObj['items'] : null;
  const out: Record<string, AgentAuthFailureInfo> = {};
  if (!Array.isArray(itemsRaw)) return out;
  for (const raw of itemsRaw) {
    if (!isRecord(raw) || raw['type'] !== 'agent_auth_failure') continue;
    const memberId = typeof raw['member_id'] === 'string' ? raw['member_id'] : null;
    const reason = raw['reason'];
    if (!memberId || (reason !== 'expired' && reason !== 'revoked' && reason !== 'invalid')) continue;
    const failureCount = typeof raw['failure_count'] === 'number' ? raw['failure_count'] : 0;
    // 한 member가 두 reason 모두로 뜰 수 있으나(동시에 revoked+새 키 expired 등, 드묾) presence
    // 행 뱃지는 1개뿐이라 먼저 만난 것을 유지한다(정렬은 BE단 없음·표시상 치명적이지 않음).
    if (!out[memberId]) out[memberId] = { reason, failureCount };
  }
  return out;
}

/** 팀 전역 presence 패널에 「인증 실패」 뱃지를 얹기 위한 얇은 폴(60s) — active=false면 폴 정지. */
export function useAgentAuthFailures(active: boolean): Record<string, AgentAuthFailureInfo> {
  const [failures, setFailures] = useState<Record<string, AgentAuthFailureInfo>>({});

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const load = async () => {
      const json = await fetchWithAuth('/api/dashboard/my-actions').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!cancelled) setFailures(parseAgentAuthFailures(json));
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [active]);

  return failures;
}
