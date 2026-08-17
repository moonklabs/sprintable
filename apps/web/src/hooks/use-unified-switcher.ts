'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';
import { fetchWithAuth } from '@/lib/db/client';

export interface OrgSwitcherItem {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role?: string;
}

export interface ProjectSwitcherItem {
  projectId: string;
  projectName: string;
}

export interface UseUnifiedSwitcherArgs {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
}

async function fetchProjectSlug(projectId: string): Promise<string | null> {
  return fetch(`/api/projects/${projectId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((json: { data?: { slug?: string | null } } | null) => json?.data?.slug ?? null)
    .catch(() => null);
}

// story #2212(오르테가 지적, open-redirect 방어) — `?next=`는 사용자가 URL로 조작 가능한
// 값이다(예: 남이 보낸 링크의 쿼리스트링). 여기가 실제 소비·router.push 지점이라 이 가드가
// 없으면 로그인 상태로 외부 사이트로 튕겨 보내는 open-redirect가 된다(`//evil.com`,
// `https://evil.com`, `/\evil.com` 등). proxy.ts의 redirectToProjectPicker에도 같은 형태의
// 가드가 있지만(생성 쪽 방어는 originalPathname이 항상 안전해 이론상 불필요에 가깝다), 진짜
// 열린 문은 여기다 — 방어는 양쪽 다.
function isSafeInternalNext(value: string | null): value is string {
  return !!value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

// story f401139e — switchProject/switchOrgAndProject 예전엔 현재 searchParams를 통째로
// 이월하고 `p`만 갈아끼웠다. `withSwitchedSlugs`는 pathname 세그먼트[0]/[1](org/project slug)만
// 바꿀 뿐 세그먼트[2:]나 쿼리파라미터 안의 리소스 id는 그대로 두므로, `?story=`/`?id=` 같은
// 리소스-scoped 파라미터가 새 프로젝트로 그대로 넘어가면 존재하지도 않는(또는 다른 프로젝트
// 소속) 리소스를 새 URL 아래서 열려고 시도하게 된다(`flow?story=`는 로컬 필터링 목록에서
// 찾는 구현이라 우연히 안전했을 뿐 — 그라운딩 확認, 설계가 아니었다). 화이트리스트 방식으로
// 뒤집는다: 프로젝트-무관 UI 상태만 명시로 이월하고, 나머지는 기본적으로 버린다 — 이후
// 새 쿼리파라미터가 추가돼도 여기 명시로 추가하지 않는 한 자동으로 안전하다.
//
// 드랍(리소스/필터-scoped, 재검토 시 이 목록 갱신):
//   story·hypothesis·goal·id·slug — 리소스 id/슬러그 직참조(flow·sprints·docs 등)
//   task_id·epic_id·sprint_id·assignee_id — kanban 보드 필터(값이 특정 프로젝트에 종속)
//   from·pn·messageId — chats/[conversation_id]의 프로젝트-교차 진입 컨텍스트
//   agent_id — channel 페이지의 프로젝트 종속 에이전트 참조
const PROJECT_AGNOSTIC_QUERY_PARAMS = ['view', 'tab'] as const;

function withProjectAgnosticParams(searchParams: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams();
  for (const key of PROJECT_AGNOSTIC_QUERY_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) sp.set(key, value);
  }
  return sp;
}

// story #2039 AC4 — 라이브 재현 확認(2026-07-20): switchProject/switchOrgAndProject가 URL 경로는
// 그대로 두고 `?p=`만 갈아끼워서 ①목록이 안 바뀐 것처럼 보이고 ②사이드바를 누르는 순간에야 새
// 프로젝트 slug로 이동해 그 slug가 미정규화(한글 등)면 404가 터진다(#2039 본체와 결합해 증폭).
// `/{ws}/{proj}/...` 아래 라우트는 `[ws]` 밑에 `[proj]`만 존재(다른 org-레벨 세그먼트 없음)라
// pathname 첫 세그먼트가 현재 org slug와 일치하면 그 경로는 반드시 project-scoped이고, 둘째
// 세그먼트가 project slug다 — 그 둘만 교체하면 나머지(리소스+하위 경로)는 그대로 보존된다.
// 현재 화면 유지가 컨텍스트 보존에 맞다고 판단(PO 동의) — 기본 화면으로 보내는 대안은 기각.
export function withSwitchedSlugs(
  pathname: string,
  currentOrgSlug: string | undefined,
  newOrgSlug: string,
  newProjectSlug: string,
): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || !currentOrgSlug || segments[0] !== currentOrgSlug) return null;
  segments[0] = newOrgSlug;
  segments[1] = newProjectSlug;
  return `/${segments.join('/')}`;
}

/**
 * story #2076 — UnifiedSwitcher(사이드바, ≥1024)와 신규 ContextSwitcherChip(top-bar 칩+
 * 바텀시트, <1024)가 공유하는 전환 로직. 원래 unified-switcher.tsx에 있던 상태·핸들러를
 * 그대로 추출했다 — 동작을 재구현하지 않고 "재사용"한 것(#2039 AC4가 이 스위칭 경로에서
 * 고친 slug-path 보존·optimistic rollback·per-tab sessionStorage 동기 전부를 두 표현이
 * 똑같이 물려받는다). 컨테이너(DropdownMenu vs Sheet)만 두 곳이 각자 고른다 — `open`은
 * 훅이 들고 있지만 그 값을 어느 UI 프리미티브의 open/onOpenChange에 묶을지는 호출부 몫이다.
 */
export function useUnifiedSwitcher({ orgs, currentOrgId, projects, currentProjectId }: UseUnifiedSwitcherArgs) {
  const tSwitcher = useTranslations('nav');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const [otherOrgProjects, setOtherOrgProjects] = useState<Record<string, ProjectSwitcherItem[]>>({});
  const [loadingOrgIds, setLoadingOrgIds] = useState<Set<string>>(new Set());
  // story #2468(P0, 2026-08-06 미르코 라이브 재현) — 프로젝트 생성 「무반응」의 정체는 조용한
  // 403이었다. 실패를 담아 다이얼로그에 명시로 보여준다(어떤 실패든 침묵하지 않는 게 근본 — a
  // 만으론 다음 다른 실패가 또 조용히 묻힌다).
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  // story #2544 — switchOrg/switchOrgAndProject는 `localOrgId`를 optimistic으로 먼저 찍고
  // (아래 참고) try에 catch 없이 finally만 있었다. `fetch` 자체가 던지면(네트워크 실패 등)
  // else 분기(revert)를 절대 못 타 — 실제 전환은 실패했는데 드롭다운은 "전환됨"으로 영구
  // 고정된다(카디르 QA 라이브 재현의 정확한 모양: 선택·체크는 되는데 다음 org로 실제 안 감).
  // #2468이 프로젝트 생성 경로에서 이미 고친 것과 같은 클래스(침묵 실패) — 여기 재발.
  const [switchOrgError, setSwitchOrgError] = useState<string | null>(null);

  const [localOrgId, setLocalOrgId] = useState<string | undefined>(currentOrgId);

  useEffect(() => {
    setLocalOrgId(currentOrgId);
  }, [currentOrgId]);

  const currentOrg = orgs.find((o) => o.orgId === localOrgId);
  const otherOrgs = orgs.filter((o) => o.orgId !== localOrgId);

  const displayOrg = currentOrg?.orgName ?? 'Organization';

  // story #2093 후속 — `projects`(서버 `/me/memberships`, JWT "현재 org" 클레임 스코프) prop은
  // localOrgId(=URL 경로 resolve 결과, #2093 이후)와 다른 org를 가리킬 수 있다(cross-org 진입 —
  // 계정 상태가 stale하거나 초대/딥링크로 다른 org에 들어온 경우). 그 상태에서 `projects`를
  // 그대로 "현재 조직 섹션"에 그리면 다른 org의 프로젝트가 마치 이 org 소속인 것처럼 보인다
  // (라이브 재현: 계정상태=HITL Dogfood, URL=뭉클랩일 때 "뭉클랩" 헤더 아래 "Dogfood Project"가
  // 뜸). "다른 조직"에 이미 있는 X-Org-Id lazy-fetch를 현재 조직에도 똑같이 적용해 스코프
  // 불일치 자체를 없앤다 — 정본은 항상 방금 그 org로 헤더를 찍어 다시 조회한 응답이다.
  const currentOrgFetched = localOrgId ? otherOrgProjects[localOrgId] : undefined;
  const currentOrgLoading = localOrgId ? loadingOrgIds.has(localOrgId) : false;
  // fetch 전(혹은 org 없음)엔 서버 prop을 낙관적으로 보여준다 — 대부분(같은 org)은 이 값이 곧
  // fetch 결과와 같아 깜빡임이 없고, 다르면 fetch 완료 즉시 정본으로 교체된다.
  const currentOrgProjects = currentOrgFetched ?? projects;
  const currentProject = currentOrgProjects.find((p) => p.projectId === currentProjectId);
  const displayProject = currentProject?.projectName ?? '';

  useEffect(() => {
    if (!open) return;
    const orgsToFetch = localOrgId ? [{ orgId: localOrgId }, ...otherOrgs] : otherOrgs;
    for (const org of orgsToFetch) {
      if (otherOrgProjects[org.orgId] !== undefined || loadingOrgIds.has(org.orgId)) continue;
      setLoadingOrgIds((prev) => new Set([...prev, org.orgId]));
      fetchWithAuth(`/api/projects`, { headers: { 'X-Org-Id': org.orgId } })
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { data?: Array<{ id?: string; projectId?: string; name?: string; projectName?: string }> } | null) => {
          const mapped = (data?.data ?? []).map((p) => ({
            projectId: p.id ?? p.projectId ?? '',
            projectName: p.name ?? p.projectName ?? '',
          }));
          setOtherOrgProjects((prev) => ({ ...prev, [org.orgId]: mapped }));
        })
        .catch(() => {
          setOtherOrgProjects((prev) => ({ ...prev, [org.orgId]: [] }));
        })
        .finally(() => {
          setLoadingOrgIds((prev) => { const n = new Set(prev); n.delete(org.orgId); return n; });
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, localOrgId]);

  async function switchOrg(nextOrgId: string) {
    if (!nextOrgId || nextOrgId === localOrgId || pending) return;
    const prevOrgId = localOrgId;
    setPending(true);
    setSwitchOrgError(null);
    setLocalOrgId(nextOrgId);
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      const json = await res.json().catch(() => null) as { data?: { ok?: boolean } } | null;
      if (res.ok && json?.data?.ok) {
        // story #2468(a) — 이 경로는 대상 org의 특정 프로젝트를 아직 모른다(그건 이후
        // switchProject/createProject가 정한다). 전환 前 org의 project_id를 그대로 두면
        // fetch 인터셉터(project-context-client.ts)가 그 stale id를 X-Project-Id로 계속
        // 실어 보내 — 새 org엔 없는 프로젝트라 BE가 403(멤버십 검증 실패)을 낸다. 실측:
        // 0-프로젝트 org로 전환 후 "새 프로젝트" 생성 시도가 이 stale 헤더 때문에 조용히 막혔다.
        if (typeof window !== 'undefined') window.sessionStorage.removeItem(TAB_PROJECT_STORAGE_KEY);
        router.refresh();
      } else {
        setLocalOrgId(prevOrgId);
        setSwitchOrgError(tSwitcher('switcherSwitchOrgError'));
      }
    } catch {
      // story #2544 — fetch 자체 실패(네트워크 등)도 실패다. catch 없이 finally만 있으면
      // 위 optimistic setLocalOrgId(nextOrgId)가 절대 안 풀린다(핵심 재현 지점).
      setLocalOrgId(prevOrgId);
      setSwitchOrgError(tSwitcher('switcherSwitchOrgError'));
    } finally {
      setPending(false);
    }
  }

  async function switchOrgAndProject(nextOrgId: string, projectId: string) {
    if (pending) return;
    const prevOrgId = localOrgId;
    setPending(true);
    setSwitchOrgError(null);
    setLocalOrgId(nextOrgId);
    try {
      const orgRes = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      if (!orgRes.ok) {
        setLocalOrgId(prevOrgId);
        setSwitchOrgError(tSwitcher('switcherSwitchOrgError'));
        return;
      }
      await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      }).catch(() => null);
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, projectId);
      // story #2212 — proxy.ts가 "프로젝트 미확定" 404 대신 /org-briefing?next=<원 목적지>로
      // 보낸 경우, 여기서 그 next를 읽어 프로젝트 선택 "직후" 원래 가려던 곳으로 돌려보낸다
      // ("고르면 여기로 돌아온다"). CURRENT_PROJECT_COOKIE는 위 switch-project 응답이 이미
      // Set-Cookie로 반영했으므로 이 시점에 next로 이동하면 그 목적지는 정상 해소된다.
      const nextRaw = searchParams.get('next');
      const nextTarget = isSafeInternalNext(nextRaw) ? nextRaw : null;
      if (nextTarget) {
        router.push(nextTarget);
        return;
      }
      const sp = withProjectAgnosticParams(searchParams);
      sp.set('p', projectId);
      const newOrgSlug = orgs.find((o) => o.orgId === nextOrgId)?.orgSlug;
      const newSlug = newOrgSlug ? await fetchProjectSlug(projectId) : null;
      const switchedPath = newOrgSlug && newSlug ? withSwitchedSlugs(pathname, currentOrg?.orgSlug, newOrgSlug, newSlug) : null;
      router.push(`${switchedPath ?? pathname}?${sp.toString()}`);
      router.refresh();
    } catch {
      // story #2544 — switchOrg와 동일 함정: orgRes 이후(switch-project/slug 해소/router.push)
      // 어디서든 던지면 org는 이미 전환됐는데 UI만 이전 상태로 안 돌아가는 반쪽짜리 실패가 된다.
      // org 전환 자체는 이미 성공했을 수 있어 prevOrgId로 되돌리지 않는다 — 다음 router.refresh
      // (사용자가 재시도·재진입 시)가 실제 서버 상태를 다시 반영하게 둔다. 에러만 명시한다.
      setSwitchOrgError(tSwitcher('switcherSwitchOrgError'));
    } finally {
      setPending(false);
    }
  }

  async function switchProject(nextProjectId: string) {
    if (!nextProjectId || nextProjectId === currentProjectId || pending) return;
    setPending(true);
    try {
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, nextProjectId);
      // story #2212 — next 목적지는 middleware가 CURRENT_PROJECT_COOKIE를 보고 판정하므로,
      // 기존 경로(낙관적 push 먼저·fetch 나중)와 달리 여기선 push 전에 반드시 fetch가 반영돼야
      // 한다(안 그러면 next로 이동해도 쿠키가 아직 안 실려 다시 같은 처방으로 튕긴다).
      const nextRaw = searchParams.get('next');
      const nextTarget = isSafeInternalNext(nextRaw) ? nextRaw : null;
      if (nextTarget) {
        await fetch('/api/switch-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: nextProjectId }),
        }).catch(() => null);
        router.push(nextTarget);
        return;
      }
      const sp = withProjectAgnosticParams(searchParams);
      sp.set('p', nextProjectId);
      const orgSlug = currentOrg?.orgSlug;
      const newSlug = orgSlug ? await fetchProjectSlug(nextProjectId) : null;
      const switchedPath = orgSlug && newSlug ? withSwitchedSlugs(pathname, orgSlug, orgSlug, newSlug) : null;
      router.push(`${switchedPath ?? pathname}?${sp.toString()}`);
      await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: nextProjectId }),
      }).catch(() => null);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function createProject(name: string, description: string): Promise<boolean> {
    if (!name.trim() || creating) return false;
    setCreating(true);
    setCreateProjectError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          ...(currentOrgId ? { org_id: currentOrgId } : {}),
        }),
      });
      if (!res.ok) {
        // story #2468(b, 근본) — 예전엔 여기서 그냥 false만 반환했다. 호출부(unified-switcher.tsx·
        // context-switcher-chip.tsx)는 그 결과를 `void`로 버려 실패가 화면 어디에도 안 뜨고
        // 다이얼로그만 그대로 남았다 — "버튼 무반응"으로 보인 정체. 원인이 뭐든(403/기타) 침묵
        // 하지 않는다: (a)가 이번 원인(stale project_id 헤더)은 없앴지만, 다음 다른 실패가 또
        // 조용히 묻히지 않도록 실패 표시 자체를 근본으로 남긴다.
        setCreateProjectError(tSwitcher('switcherCreateProjectError'));
        return false;
      }
      const data = await res.json() as { id?: string; data?: { id: string } };
      const newId = data.id ?? data.data?.id;
      setCreateProjectOpen(false);
      setNewProjectName('');
      setNewProjectDesc('');
      setCreateProjectError(null);
      if (newId) await switchProject(newId);
      else router.refresh();
      return true;
    } catch {
      setCreateProjectError(tSwitcher('switcherCreateProjectError'));
      return false;
    } finally {
      setCreating(false);
    }
  }

  function handleOrgCreated(orgId: string) {
    window.location.href = `/onboarding?step=project&orgId=${orgId}`;
  }

  // story #2468(b) — 다이얼로그를 열고 닫을 때마다 이전 실패 문구를 지운다. 안 지우면 재시도
  // 성공 뒤 다시 열었을 때(취소→재오픈) 낡은 에러가 새 시도처럼 보일 수 있다.
  function setCreateProjectOpenAndClearError(nextOpen: boolean) {
    setCreateProjectError(null);
    setCreateProjectOpen(nextOpen);
  }

  return {
    pending,
    open, setOpen,
    createOrgOpen, setCreateOrgOpen,
    createProjectOpen, setCreateProjectOpen: setCreateProjectOpenAndClearError,
    createProjectError,
    switchOrgError,
    newProjectName, setNewProjectName,
    newProjectDesc, setNewProjectDesc,
    creating,
    otherOrgProjects,
    loadingOrgIds,
    currentOrg,
    currentProject,
    currentOrgProjects,
    currentOrgLoading: currentOrgLoading && currentOrgFetched === undefined,
    otherOrgs,
    displayOrg,
    displayProject,
    currentProjectId,
    switchOrg,
    switchOrgAndProject,
    switchProject,
    createProject,
    handleOrgCreated,
  };
}
