'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { HumanOnlyAction } from '@/components/ui/human-only-action';

interface GoalRowContextMenuProps {
  x: number;
  y: number;
  /** «목표 수정» is drawn only where the detail column stands beside the list (wide): editing happens there */
  canEdit: boolean;
  onOpenFull: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * story 4954 (the desktop app's goals list) — the menu a right-click on a goal row opens: ONLY what the goal already has — «전체 보기» and «목표 수정» (the detail column's two buttons) and, last after a rule, «목표 삭제» (the row's own delete: the same
 * confirmation window; shown to a person only, like the trigger on the row). The same words as those buttons · the same menu part the room-row menu uses (`DropdownMenu`: keys · focus · Esc · an outside press are its own), opened AT THE POINTER.
 * The delete item reads as the board card's does: plain ink, a tint under it on hover — never red.
 */
export function GoalRowContextMenu({ x, y, canEdit, onOpenFull, onEdit, onDelete, onClose }: GoalRowContextMenuProps) {
  const t = useTranslations('goals');
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenuContent anchor={anchor} side="bottom" align="start" sideOffset={0} className="w-48" data-testid="goal-row-menu">
        <DropdownMenuItem onClick={onOpenFull} data-testid="goal-row-open">{t('viewFull')}</DropdownMenuItem>
        {canEdit ? <DropdownMenuItem onClick={onEdit} data-testid="goal-row-edit">{t('editGoal')}</DropdownMenuItem> : null}
        <HumanOnlyAction>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} data-testid="goal-row-delete" className="text-foreground hover:bg-destructive-tint focus:bg-destructive-tint">{t('deleteGoal')}</DropdownMenuItem>
        </HumanOnlyAction>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
