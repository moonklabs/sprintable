'use client';

import { useTranslations } from 'next-intl';
import type { KanbanEpic, KanbanMember, KanbanSprint } from './types';
import { OperatorSelect } from '@/components/ui/operator-control';

interface KanbanFiltersProps {
  sprints: KanbanSprint[];
  epics: KanbanEpic[];
  members: KanbanMember[];
  selectedSprintId: string;
  selectedEpicId: string;
  selectedAssigneeId: string;
  onSprintChange: (id: string) => void;
  onEpicChange: (id: string) => void;
  onAssigneeChange: (id: string) => void;
}

export function KanbanFilters({
  sprints,
  epics,
  members,
  selectedSprintId,
  selectedEpicId,
  selectedAssigneeId,
  onSprintChange,
  onEpicChange,
  onAssigneeChange,
}: KanbanFiltersProps) {
  const t = useTranslations('board');

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
      <OperatorSelect value={selectedSprintId} onChange={(e) => onSprintChange(e.target.value)} className="w-full sm:w-auto sm:min-w-[180px]">
        <option value="">{t('allSprints')}</option>
        {sprints.map((sprint) => (
          <option key={sprint.id} value={sprint.id}>{sprint.title}</option>
        ))}
      </OperatorSelect>
      <OperatorSelect value={selectedEpicId} onChange={(e) => onEpicChange(e.target.value)} className="w-full sm:w-auto sm:min-w-[180px]">
        <option value="">{t('allEpics')}</option>
        {epics.map((epic) => (
          <option key={epic.id} value={epic.id}>{epic.title}</option>
        ))}
      </OperatorSelect>
      <OperatorSelect value={selectedAssigneeId} onChange={(e) => onAssigneeChange(e.target.value)} className="w-full sm:w-auto sm:min-w-[180px]">
        <option value="">{t('allAssignees')}</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>{member.name}</option>
        ))}
      </OperatorSelect>
    </div>
  );
}
