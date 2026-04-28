'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Check, GitBranch, Layers, User } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface BoardSidebarFiltersProps {
  projectId?: string;
}

interface Sprint { id: string; title: string; }
interface Epic { id: string; title: string; }
interface Member { id: string; name: string; }

export function BoardSidebarFilters({ projectId }: BoardSidebarFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('board');

  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const isBoard = pathname === '/board' || pathname.startsWith('/board/');

  useEffect(() => {
    if (!isBoard || !projectId) return;

    void Promise.all([
      fetch(`/api/sprints?project_id=${projectId}`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/epics?project_id=${projectId}&limit=50`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/team-members?project_id=${projectId}`).then((r) => r.ok ? r.json() : null),
    ]).then(([sprintsRes, epicsRes, membersRes]) => {
      if (sprintsRes?.data) setSprints(sprintsRes.data as Sprint[]);
      if (epicsRes?.data) setEpics(epicsRes.data as Epic[]);
      if (membersRes?.data) setMembers(membersRes.data as Member[]);
    });
  }, [isBoard, projectId]);

  if (!isBoard) return null;

  const sprintId = searchParams.get('sprint_id') ?? '';
  const epicId = searchParams.get('epic_id') ?? '';
  const assigneeId = searchParams.get('assignee_id') ?? '';

  const selectedSprint = sprints.find((s) => s.id === sprintId);
  const selectedEpic = epics.find((e) => e.id === epicId);
  const selectedMember = members.find((m) => m.id === assigneeId);

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`/board${params.size > 0 ? `?${params.toString()}` : ''}`);
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t('filters')}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {/* Sprint */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="w-full">
                    <GitBranch className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{selectedSprint?.title ?? t('allSprints')}</span>
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="w-56" align="start" side="right" sideOffset={4}>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('sprints')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('sprint_id', '')}>
                  <span className="flex-1">{t('allSprints')}</span>
                  {!sprintId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {sprints.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => updateFilter('sprint_id', s.id)}>
                    <span className="flex-1 truncate">{s.title}</span>
                    {s.id === sprintId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          {/* Epic */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="w-full">
                    <Layers className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{selectedEpic?.title ?? t('allEpics')}</span>
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="w-56" align="start" side="right" sideOffset={4}>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('epics')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('epic_id', '')}>
                  <span className="flex-1">{t('allEpics')}</span>
                  {!epicId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {epics.map((e) => (
                  <DropdownMenuItem key={e.id} onClick={() => updateFilter('epic_id', e.id)}>
                    <span className="flex-1 truncate">{e.title}</span>
                    {e.id === epicId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          {/* Assignee */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton className="w-full">
                    <User className="size-4 shrink-0" />
                    <span className="flex-1 truncate">{selectedMember?.name ?? t('allAssignees')}</span>
                    <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                  </SidebarMenuButton>
                }
              />
              <DropdownMenuContent className="w-56" align="start" side="right" sideOffset={4}>
                <DropdownMenuLabel className="text-xs text-muted-foreground">{t('assignees')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => updateFilter('assignee_id', '')}>
                  <span className="flex-1">{t('allAssignees')}</span>
                  {!assigneeId && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
                {members.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => updateFilter('assignee_id', m.id)}>
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.id === assigneeId && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
