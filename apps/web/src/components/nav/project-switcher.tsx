'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenuButton } from '@/components/ui/sidebar';

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
  className,
}: {
  projects: ProjectSwitcherItem[];
  currentProjectId?: string;
  className?: string;
}) {
  const router = useRouter();
  const t = useTranslations('shell');
  const [pending, setPending] = useState(false);

  const currentProject = projects.find((p) => p.projectId === currentProjectId);

  if (projects.length === 0) {
    return (
      <div className="truncate px-2 py-1 text-sm font-medium text-sidebar-foreground">
        Sprintable
      </div>
    );
  }

  async function switchProject(nextProjectId: string) {
    if (!nextProjectId || nextProjectId === currentProjectId || pending) return;
    setPending(true);
    try {
      await fetch('/api/current-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: nextProjectId }),
      });
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
