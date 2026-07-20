'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';
import { Check, ChevronDown, Loader2, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';

export interface OrgSwitcherItem {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role?: string;
}

interface ProjectItem {
  projectId: string;
  projectName: string;
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

async function fetchProjectSlug(projectId: string): Promise<string | null> {
  return fetch(`/api/projects/${projectId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((json: { data?: { slug?: string | null } } | null) => json?.data?.slug ?? null)
    .catch(() => null);
}

interface UnifiedSwitcherProps {
  orgs: OrgSwitcherItem[];
  currentOrgId?: string;
  projects: ProjectItem[];
  currentProjectId?: string;
  className?: string;
}

function OrgInitial({ name }: { name: string }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-brand text-[9px] font-semibold text-brand-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function UnifiedSwitcher({
  orgs,
  currentOrgId,
  projects,
  currentProjectId,
  className,
}: UnifiedSwitcherProps) {
  const t = useTranslations('nav');
  const tCommon = useTranslations('common');
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

  // 다른 조직의 프로젝트를 lazy fetch
  const [otherOrgProjects, setOtherOrgProjects] = useState<Record<string, ProjectItem[]>>({});
  const [loadingOrgIds, setLoadingOrgIds] = useState<Set<string>>(new Set());

  // Optimistic org 상태 — API 성공 즉시 UI에 반영, router.refresh() 완료 후 서버 값과 동기화
  const [localOrgId, setLocalOrgId] = useState<string | undefined>(currentOrgId);

  // 서버에서 새 currentOrgId가 내려오면 (router.refresh() 완료 후) 로컬 상태 동기화
  useEffect(() => {
    setLocalOrgId(currentOrgId);
  }, [currentOrgId]);

  const currentOrg = orgs.find((o) => o.orgId === localOrgId);
  const currentProject = projects.find((p) => p.projectId === currentProjectId);
  const otherOrgs = orgs.filter((o) => o.orgId !== localOrgId);

  const displayOrg = currentOrg?.orgName ?? 'Organization';
  const displayProject = currentProject?.projectName ?? '';

  // 드롭다운 열릴 때 다른 조직의 프로젝트 fetch
  useEffect(() => {
    if (!open) return;
    for (const org of otherOrgs) {
      if (otherOrgProjects[org.orgId] !== undefined || loadingOrgIds.has(org.orgId)) continue;
      setLoadingOrgIds((prev) => new Set([...prev, org.orgId]));
      fetch(`/api/projects`, { headers: { 'X-Org-Id': org.orgId } })
        .then((r) => r.ok ? r.json() : null)
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
    setLocalOrgId(nextOrgId); // optimistic: 즉시 사이드바 org명 갱신
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      // 0746aab9: 200이어도 실제 전환 성공(data.ok) 여부를 확인하고 refresh — 단순 res.ok만 보면
      // 200-but-실패 케이스가 성공으로 오인돼 전환 깨진 화면이 무에러로 뜬다.
      const json = await res.json().catch(() => null) as { data?: { ok?: boolean } } | null;
      if (res.ok && json?.data?.ok) {
        router.refresh();
      } else {
        setLocalOrgId(prevOrgId); // 실패(비-2xx 또는 data.ok 아님) 시 롤백
      }
    } finally {
      setPending(false);
    }
  }

  async function switchOrgAndProject(nextOrgId: string, projectId: string) {
    if (pending) return;
    const prevOrgId = localOrgId;
    setPending(true);
    setLocalOrgId(nextOrgId); // optimistic: 즉시 사이드바 org명 갱신
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
      // org 전환 후 project 전환 (쿠키는 Set-Cookie로 이미 갱신됨)
      await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      }).catch(() => null);
      // R2: 랜딩 탭의 per-tab SSOT(sessionStorage + `?p=`)도 새 프로젝트로 동기.
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, projectId);
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
      sp.set('p', projectId);
      // story #2039 AC4 — org+project 동시 전환도 경로 세그먼트 둘 다 갱신.
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
      // R2 per-tab SSOT: 전역 reload 대신 이 탭의 sessionStorage backstop + URL `?p=` 갱신.
      // → 탭별 독립(85614dd9) + 화면/컨텍스트 동기(d802da27). 다른 탭은 자기 `?p=`로 안 흔들림.
      if (typeof window !== 'undefined') window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, nextProjectId);
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
      sp.set('p', nextProjectId);
      // story #2039 AC4 — 경로의 프로젝트 slug 세그먼트를 즉시 새 프로젝트로 교체(같은 org라
      // org 세그먼트는 유지). 실패(slug 조회 불가 등)하면 안전하게 기존 pathname으로 폴백 —
      // ?p만 갈아끼우던 원래 동작과 동일하게 degrade, 새 오류를 만들지 않는다.
      const orgSlug = currentOrg?.orgSlug;
      const newSlug = orgSlug ? await fetchProjectSlug(nextProjectId) : null;
      const switchedPath = orgSlug && newSlug ? withSwitchedSlugs(pathname, orgSlug, orgSlug, newSlug) : null;
      router.push(`${switchedPath ?? pathname}?${sp.toString()}`);
      // 쿠키/JWT 동기화(이 탭 RSC·첫 렌더용). 공유 쿠키가 덮여도 per-tab 정합은 `?p=`+sessionStorage+
      // fetch X-Project-Id 헤더가 보장하므로 무해.
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

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newProjectName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newProjectName.trim(),
          description: newProjectDesc.trim() || null,
          ...(currentOrgId ? { org_id: currentOrgId } : {}),
        }),
      });
      if (!res.ok) return;
      const data = await res.json() as { id?: string; data?: { id: string } };
      const newId = data.id ?? data.data?.id;
      setCreateProjectOpen(false);
      setNewProjectName('');
      setNewProjectDesc('');
      if (newId) await switchProject(newId);
      else router.refresh();
    } finally {
      setCreating(false);
    }
  }

  function handleOrgCreated(orgId: string) {
    window.location.href = `/onboarding?step=project&orgId=${orgId}`;
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          disabled={pending}
          render={
            <SidebarMenuButton className={cn('w-full', className)}>
              <OrgInitial name={displayOrg} />
              {/* story c4980e70(조직 헤더 1급화): 조직명=primary(굵게)·프로젝트명=secondary로 emphasis 전도 —
                  기존엔 조직명이 10px 보조 라벨이라 "조직명 부재"처럼 읽혔다(doc §1 ①). */}
              <span className="flex min-w-0 flex-1 flex-col truncate text-left">
                <span className="truncate text-xs font-semibold text-foreground leading-tight">
                  {displayOrg}
                </span>
                {/* 0746: 전환 중에는 옛 org의 프로젝트명을 숨겨 "새 org + 옛 프로젝트" 깜빡임(leak처럼 보임)을 차단 */}
                {!pending && displayProject && (
                  <span className="truncate text-[10px] font-medium text-muted-foreground leading-tight">
                    {displayProject}
                  </span>
                )}
              </span>
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent className="w-auto min-w-64" align="start" side="bottom" sideOffset={4}>
          {/* 현재 조직 */}
          <DropdownMenuGroup>
            <div className="flex items-center justify-between px-2 py-1.5">
              <DropdownMenuLabel className="p-0 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                <span className="flex items-center gap-1.5">
                  <OrgInitial name={displayOrg} />
                  {displayOrg}
                </span>
              </DropdownMenuLabel>
              <button
                type="button"
                onClick={() => { window.location.href = '/settings?tab=organization'; }}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t('switcherOrgSettingsAria')}
              >
                <Settings className="h-3 w-3" />
              </button>
            </div>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.projectId}
                disabled={pending}
                className="pl-5"
                onClick={() => void switchProject(project.projectId)}
              >
                <span className="flex-1 truncate text-sm">{project.projectName}</span>
                {project.projectId === currentProjectId && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem className="pl-5 text-muted-foreground" onClick={() => setCreateProjectOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              <span className="text-sm">{t('switcherNewProject')}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          {/* 다른 조직들 — 각 조직 아래에 프로젝트 표시 */}
          {otherOrgs.map((org) => {
            const orgProjects = otherOrgProjects[org.orgId];
            const isLoading = loadingOrgIds.has(org.orgId);
            return (
              <div key={org.orgId}>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <div className="px-2 py-1.5">
                    <DropdownMenuLabel className="p-0 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                      <span className="flex items-center gap-1.5">
                        <OrgInitial name={org.orgName} />
                        {org.orgName}
                        {org.role && (
                          <span className="text-[9px] font-normal capitalize normal-case opacity-60">{org.role}</span>
                        )}
                      </span>
                    </DropdownMenuLabel>
                  </div>
                  {isLoading ? (
                    <div className="flex items-center gap-2 pl-5 py-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>{tCommon('loading')}</span>
                    </div>
                  ) : orgProjects && orgProjects.length > 0 ? (
                    orgProjects.map((project) => (
                      <DropdownMenuItem
                        key={project.projectId}
                        disabled={pending}
                        className="pl-5"
                        onClick={() => void switchOrgAndProject(org.orgId, project.projectId)}
                      >
                        <span className="flex-1 truncate text-sm">{project.projectName}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem
                      disabled={pending}
                      className="pl-5 text-muted-foreground"
                      onClick={() => void switchOrg(org.orgId)}
                    >
                      <span className="text-sm">{t('switcherSwitchToOrg')}</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </div>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOrgOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            <span className="text-sm">{t('switcherNewOrganization')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateOrganizationDialog
        open={createOrgOpen}
        onOpenChange={setCreateOrgOpen}
        onCreated={handleOrgCreated}
      />

      <Dialog open={createProjectOpen} onOpenChange={setCreateProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('switcherNewProjectDialogTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void createProject(e)} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-name">
                {t('switcherProjectNameLabel')} <span className="text-destructive">*</span>
              </label>
              <input
                id="unified-proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectNamePlaceholder')}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-desc">
                {t('switcherDescriptionLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
              </label>
              <textarea
                id="unified-proj-desc"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder={t('switcherProjectDescPlaceholder')}
                rows={3}
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" disabled={creating}>{tCommon('cancel')}</Button>} />
              <Button type="submit" disabled={!newProjectName.trim() || creating}>
                {creating ? t('switcherCreating') : t('switcherCreateButton')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
