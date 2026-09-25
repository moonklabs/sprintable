'use client';

import { useMemo } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { useAsyncResource } from './use-async-resource';

/**
 * [SID:4300] 이름표 = 프로젝트 범위 + 없을 때 조직 범위(PO 決 2026-09-25 03:45Z).
 *
 * 보드 · 팀 활동 · 스토리 패널은 `/api/members?project_id=`(프로젝트 범위)로 이름표를 만든다 — 담당자 «고르는» 목록은
 * 권한 있는 사람만이어야 해서 그 범위가 맞다. 그런데 «이미 적힌» id(검증자 · 담당 · 행위자)는 권한이 회수된 사람 ·
 * 다른 프로젝트 에이전트일 수 있어, 표에 없으면 아는 사람을 «알 수 없는 구성원»으로 말하게 된다.
 *
 * 이 훅은 보이는 id 가운데 프로젝트 표에 없는 것이 있을 때만(첫 화면 뒤 — effect에서) 조직 범위 목록
 * `ORG_NAMES_URL`(= `/api/team-members?include_inactive=true` · project_id 없음 · team_members.py org 갈래 — 조직 사람 전원 +
 * 에이전트 전원(비활성 포함 · 기존 인자) · 같은 org_member.id / team_member.id 공간)을 한 번 받아 빈 칸만 채운다.
 * 비활성 에이전트도 «목록이 거른 것»이지 «모름»이 아니라서(유나 판정 · 4300 본문) 비활성을 싣는 원천을 쓴다. 프로젝트 표 값이 늘 이긴다. 조직 목록은 org별로 모듈에서 한 번만 받는다(동시 호출은 한 요청으로
 * 합침 · 5분 뒤 다시). 받는 동안 `loaded=false` — 호출부는 4286 memberLookup 뼈대(null → 자리표시)로 «알 수 없음»이 먼저
 * 떴다가 이름으로 바뀌는 거짓을 막는다. 실패하면 `loaded=true`(빈 칸은 «알 수 없는 구성원»으로 선다).
 *
 * 조직 목록에도 없는 id는 그대로 비어 있다(«알 수 없는 구성원»). 조직을 떠난 사람(org_members.deleted_at)이 여기에 해당 —
 * 이름만 푸는 원천은 BE 카드(미르코 · PO 03:49Z)가 생기면 이 훅이 «프로젝트 → 조직 → 그 원천» 순으로 잇는다.
 */

export interface OrgMember {
  id: string;
  name: string | null;
  type: string;
  runtime_type?: string | null;
}

export const ORG_NAMES_URL = '/api/team-members?include_inactive=true';
const ORG_MEMBERS_TTL_MS = 5 * 60_000;
const orgMembersCache = new Map<string, { at: number; promise: Promise<Record<string, OrgMember>> }>();

async function fetchOrgMembers(): Promise<Record<string, OrgMember>> {
  const res = await fetchWithAuth(ORG_NAMES_URL);
  if (!res.ok) throw new Error(`org members ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  const rows = Array.isArray(json?.data) ? (json.data as OrgMember[]) : [];
  const map: Record<string, OrgMember> = {};
  for (const m of rows) if (m && typeof m.id === 'string') map[m.id] = m;
  return map;
}

export function loadOrgMembers(orgId: string, now: number = Date.now()): Promise<Record<string, OrgMember>> {
  const hit = orgMembersCache.get(orgId);
  if (hit && now - hit.at < ORG_MEMBERS_TTL_MS) return hit.promise;
  const promise = fetchOrgMembers();
  orgMembersCache.set(orgId, { at: now, promise });
  // 실패는 캐시에 남기지 않는다 — 다음 화면이 다시 시도.
  promise.catch(() => { if (orgMembersCache.get(orgId)?.promise === promise) orgMembersCache.delete(orgId); });
  return promise;
}

export function resetOrgMembersCacheForTests(): void {
  orgMembersCache.clear();
}

export interface MemberNameFallback<M> {
  /** 프로젝트 표 + (받았으면) 조직 표로 빈 칸만 채운 표. 프로젝트 값이 이긴다. */
  memberMap: Record<string, M | OrgMember>;
  /** 보이는 id가 전부 풀렸거나, 조직 목록을 받아 봤거나(실패 포함), 받을 일이 없으면 true. */
  loaded: boolean;
}

// 실패도 «이 org로 받아 봤음»으로 싣는다(org 전환 직후 옛 org의 실패 표시가 새 org를 loaded로 보이게 하지 않게).
type OrgMembersResult = { orgId: string; map: Record<string, OrgMember> | null } | null;

/**
 * @param orgId 현재 org(없으면 조직 목록을 안 받는다 — 프로젝트 표만).
 * @param projectMap 프로젝트 범위 이름표.
 * @param ids 이 화면에 보이는 id(빈 값 무시).
 * @param projectLoaded 프로젝트 표를 다 받았는지 — 받기 전엔 «없음»을 판단하지 않는다.
 */
export function useMemberNameFallback<M>(
  orgId: string | null | undefined,
  projectMap: Record<string, M>,
  ids: ReadonlyArray<string | null | undefined>,
  projectLoaded: boolean,
): MemberNameFallback<M> {
  const missing = ids.some((id) => !!id && !Object.hasOwn(projectMap, id));
  const key = projectLoaded && missing && orgId ? orgId : undefined;
  const { data } = useAsyncResource<string, OrgMembersResult>(
    key, null,
    async (id) => ({ orgId: id, map: await loadOrgMembers(id).catch(() => null) }),
  );
  // 이 org의 결과일 때만 쓴다(org 전환 직후 옛 org 표가 섞이지 않게).
  const triedThisOrg = !!data && data.orgId === orgId;
  const orgMap = triedThisOrg ? data.map : null;
  // 호출부가 표를 memo하면 합친 표도 같은 객체로 남는다(아래 useMemo · useCallback 의존이 매 렌더 바뀌지 않게).
  const memberMap = useMemo<Record<string, M | OrgMember>>(() => {
    if (!orgMap) return projectMap;
    const merged: Record<string, M | OrgMember> = { ...orgMap };
    for (const [id, m] of Object.entries(projectMap)) merged[id] = m;
    return merged;
  }, [orgMap, projectMap]);
  return { memberMap, loaded: projectLoaded && (!key || triedThisOrg) };
}
