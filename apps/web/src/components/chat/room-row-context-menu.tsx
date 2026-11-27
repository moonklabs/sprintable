'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, BellOff, Settings } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';

interface RoomRowContextMenuProps {
  x: number;
  y: number;
  muted: boolean;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

/**
 * story 4946 (the desktop app's chat list) — the menu a right-click on a room row opens: ONLY what the room's own «⋯» menu already has (mute · the notification settings), the same words and the same menu parts
 * (`DropdownMenu` — keys, focus, Escape, an outside press are its own). It opens AT THE POINTER: the menu is anchored to a zero-size box at the click. It is controlled by the caller, who also gives the row its focus back.
 */
export function RoomRowContextMenu({ x, y, muted, onToggleMute, onOpenSettings, onClose }: RoomRowContextMenuProps) {
  const t = useTranslations('chats');
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }), [x, y]);
  return (
    <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DropdownMenuContent anchor={anchor} side="bottom" align="start" sideOffset={0} className="w-48" data-testid="room-row-menu">
        <DropdownMenuItem onClick={onToggleMute} data-testid="room-row-mute">
          {muted ? <Bell className="size-ds-icon-sm text-muted-foreground" /> : <BellOff className="size-ds-icon-sm text-muted-foreground" />}
          {muted ? t('unmuteNotifications') : t('muteNotifications')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenSettings} data-testid="room-row-settings">
          <Settings className="size-ds-icon-sm text-muted-foreground" />
          {t('deliveryContractTitle')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
