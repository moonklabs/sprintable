'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  const router = useRouter();
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

  const currentOrg = orgs.find((o) => o.orgId === currentOrgId);
  const currentProject = projects.find((p) => p.projectId === currentProjectId);
  const otherOrgs = orgs.filter((o) => o.orgId !== currentOrgId);

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
    if (!nextOrgId || nextOrgId === currentOrgId || pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      if (res.ok) {
        window.location.href = '/dashboard';
      }
    } finally {
      setPending(false);
    }
  }

  async function switchOrgAndProject(nextOrgId: string, projectId: string) {
    if (pending) return;
    setPending(true);
    try {
      const orgRes = await fetch('/api/switch-org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: nextOrgId }),
      });
      if (!orgRes.ok) return;
      // org 전환 후 project 전환 (쿠키는 Set-Cookie로 이미 갱신됨)
      await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId }),
      }).catch(() => null);
      window.location.href = '/dashboard';
    } finally {
      setPending(false);
    }
  }

  async function switchProject(nextProjectId: string) {
    if (!nextProjectId || nextProjectId === currentProjectId || pending) return;
    setPending(true);
    try {
      const res = await fetch('/api/switch-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: nextProjectId }),
      });
      if (res.ok) {
        window.location.reload();
      }
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
              <span className="flex min-w-0 flex-1 flex-col truncate text-left">
                <span className="truncate text-[10px] font-medium text-muted-foreground leading-tight">
                  {displayOrg}
                </span>
                {displayProject && (
                  <span className="truncate text-xs font-semibold text-foreground leading-tight">
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
                aria-label="Organization 설정"
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
              <span className="text-sm">새 프로젝트</span>
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
                      <span>로딩 중...</span>
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
                      <span className="text-sm">이 조직으로 전환</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </div>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOrgOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            <span className="text-sm">새 Organization 만들기</span>
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
            <DialogTitle>새 프로젝트 만들기</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void createProject(e)} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-name">
                프로젝트 이름 <span className="text-destructive">*</span>
              </label>
              <input
                id="unified-proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="예: 웹 리뉴얼"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="unified-proj-desc">
                설명 <span className="text-muted-foreground text-xs">(선택)</span>
              </label>
              <textarea
                id="unified-proj-desc"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="프로젝트에 대한 간단한 설명"
                rows={3}
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" disabled={creating}>취소</Button>} />
              <Button type="submit" disabled={!newProjectName.trim() || creating}>
                {creating ? '생성 중…' : '만들기'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
