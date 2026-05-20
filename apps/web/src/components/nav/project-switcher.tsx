'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, Plus } from 'lucide-react';
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
import { SidebarMenuButton } from '@/components/ui/sidebar';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface ProjectSwitcherItem {
  projectId: string;
  projectName: string;
}

function ProjectInitial({ name }: { name: string }) {
  return (
    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-brand text-[10px] font-semibold text-brand-foreground">
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export function ProjectSwitcher({
  projects,
  currentProjectId,
  orgId,
  className,
}: {
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  orgId?: string;
  className?: string;
}) {
  const router = useRouter();
  const t = useTranslations('shell');
  const [pending, setPending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null, ...(orgId ? { org_id: orgId } : {}) }),
      });
      if (!res.ok) return;
      const data = await res.json() as { id?: string; data?: { id: string } };
      const newId = data.id ?? data.data?.id;
      setDialogOpen(false);
      setNewName('');
      setNewDesc('');
      if (newId) await switchProject(newId);
      else router.refresh();
    } finally {
      setCreating(false);
    }
  }

  const currentProject = projects.find((p) => p.projectId === currentProjectId);

  if (projects.length === 0) {
    return (
      <div className="truncate px-2 py-1 text-sm font-medium text-sidebar-foreground">
        Sprintable
      </div>
    );
  }

  // 단일 프로젝트 — 드롭다운 없이 이름만 표시
  if (projects.length === 1) {
    return (
      <SidebarMenuButton className={cn('w-full cursor-default', className)} disabled>
        <ProjectInitial name={currentProject?.projectName ?? 'S'} />
        <span className="flex-1 truncate font-medium">
          {currentProject?.projectName ?? projects[0]?.projectName ?? 'Sprintable'}
        </span>
      </SidebarMenuButton>
    );
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={pending}
          render={
            <SidebarMenuButton className={cn('w-full', className)}>
              <ProjectInitial name={currentProject?.projectName ?? 'S'} />
              <span className="flex-1 truncate font-medium">
                {currentProject?.projectName ?? t('projectSelectPrompt')}
              </span>
              <ChevronDown className="size-3 text-muted-foreground" />
            </SidebarMenuButton>
          }
        />
        <DropdownMenuContent className="w-auto min-w-56" align="start" side="bottom" sideOffset={4}>
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('projects')}
            </DropdownMenuLabel>
            {projects.map((project) => (
              <DropdownMenuItem
                key={project.projectId}
                onClick={() => void switchProject(project.projectId)}
              >
                <ProjectInitial name={project.projectName} />
                <span className="flex-1 truncate">{project.projectName}</span>
                {project.projectId === currentProjectId && (
                  <Check className="h-3.5 w-3.5 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDialogOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            <span>새 프로젝트</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 프로젝트 만들기</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => void createProject(e)} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="proj-name">
                프로젝트 이름 <span className="text-destructive">*</span>
              </label>
              <input
                id="proj-name"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="예: 웹 리뉴얼"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="proj-desc">
                설명 <span className="text-muted-foreground text-xs">(선택)</span>
              </label>
              <textarea
                id="proj-desc"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="프로젝트에 대한 간단한 설명"
                rows={3}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
              />
            </div>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="ghost" disabled={creating}>취소</Button>} />
              <Button type="submit" disabled={!newName.trim() || creating}>
                {creating ? '생성 중…' : '만들기'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
