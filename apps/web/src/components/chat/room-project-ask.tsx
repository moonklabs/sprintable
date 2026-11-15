'use client';

import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';

export interface RoomProjectChoice { projectId: string; projectName: string }

/**
 * The bar at the top of a room that has NO project of its own (story 4847): «이 방에는 프로젝트가 없어요 — …» and the select to pick the project the room's stories · docs · attachments go to.
 * Story 4906 (lap 4): on a phone the label (one 310 px line, `flex-shrink-0`) and the select sat in ONE row, so the select was squeezed to 40 px at 390 (26 px at 360) — its own 24 px of padding left no room for a letter, only the arrow,
 * and it was far under a 44 px press. Below `sm` the row wraps: the label first, the select under it at the full width and 44 px high. From `sm` up nothing changes (one row, the select up to `max-w-xs`).
 */
export function RoomProjectAsk({ value, projects, onChange }: { value: string; projects: RoomProjectChoice[]; onChange: (projectId: string) => void }) {
  const t = useTranslations('chats');
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2 sm:flex-row sm:items-center" data-testid="room-project-ask">
      <label htmlFor="room-project" className="text-xs text-muted-foreground sm:flex-shrink-0">{t('roomProjectAsk')}</label>
      <Select id="room-project" value={value} onChange={(e) => onChange(e.target.value)} className="max-w-xs max-sm:h-11 max-sm:max-w-none">
        <option value="">{t('newRoomProjectPick')}</option>
        {projects.map((p) => (
          <option key={p.projectId} value={p.projectId}>{p.projectName}</option>
        ))}
      </Select>
    </div>
  );
}
