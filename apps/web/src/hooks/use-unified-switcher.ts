'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

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

  const [localOrgId, setLocalOrgId] = useState<string | undefined>(currentOrgId);

  useEffect(() => {
    setLocalOrgId(currentOrgId);
  }, [currentOrgId]);

  const currentOrg = orgs.find((o) => o.orgId === localOrgId);
  const currentProject = projects.find((p) => p.projectId === currentProjectId);
  const otherOrgs = orgs.filter((o) => o.orgId !== localOrgId);

  const displayOrg = currentOrg?.orgName ?? 'Organization';
  const displayProject = currentProject?.projectName ?? '';

  useEffect(() => {
    if (!open) return;
    for (const org of otherOrgs) {
      if (otherOrgProjects[org.orgId] !== undefined || loadingOrgIds.has(org.orgId)) continue;
      setLoadingOrgIds((prev) => new Set([...prev, org.orgId]));
      fetch(`/api/projects`, { headers: { 'X-Org-Id': org.orgId } })
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
  }, [open]);

  async function switchOrg(nextOrgId: string) {
    if (!nextOrgId || nextOrgId === localOrgId || pending) return;
    const prevOrgId = localOrgId;
    setPending(true);
    setLocalOrgId(nextOrgId);
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      const json = await res.json().catch(() => null) as { data?: { ok?: boolean } } | null;
      if (res.ok && json?.data?.ok) {
        router.refresh();
      } else {
        setLocalOrgId(prevOrgId);
      }
    } finally {
      setPending(false);
    }
  }

  async function switchOrgAndProject(nextOrgId: string, projectId: string) {
    if (pending) return;
    const prevOrgId = localOrgId;
    setPending(true);
    setLocalOrgId(nextOrgId);
    try {
      const orgRes = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      if (!orgRes.ok) {
        setLocalOrgId(prevOrgId);
        return;
      }
      await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      }).catch(() => null);
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, projectId);
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
      sp.set('p', projectId);
      const newOrgSlug = orgs.find((o) => o.orgId === nextOrgId)?.orgSlug;
      const newSlug = newOrgSlug ? await fetchProjectSlug(projectId) : null;
      const switchedPath = newOrgSlug && newSlug ? withSwitchedSlugs(pathname, currentOrg?.orgSlug, newOrgSlug, newSlug) : null;
      router.push(`${switchedPath ?? pathname}?${sp.toString()}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  async function switchProject(nextProjectId: string) {
    if (!nextProjectId || nextProjectId === currentProjectId || pending) return;
    setPending(true);
    try {
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, nextProjectId);
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
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
      if (!res.ok) return false;
      const data = await res.json() as { id?: string; data?: { id: string } };
      const newId = data.id ?? data.data?.id;
      setCreateProjectOpen(false);
      setNewProjectName('');
      setNewProjectDesc('');
      if (newId) await switchProject(newId);
      else router.refresh();
      return true;
    } finally {
      setCreating(false);
    }
  }

  function handleOrgCreated(orgId: string) {
    window.location.href = `/onboarding?step=project&orgId=${orgId}`;
  }

  return {
    pending,
    open, setOpen,
    createOrgOpen, setCreateOrgOpen,
    createProjectOpen, setCreateProjectOpen,
    newProjectName, setNewProjectName,
    newProjectDesc, setNewProjectDesc,
    creating,
    otherOrgProjects,
    loadingOrgIds,
    currentOrg,
    currentProject,
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
