'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, BellOff, Settings } from 'lucide-react';

interface RoomRowContextMenuProps {
  x: number;
  y: number;
  muted: boolean;
  onToggleMute: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}

/**
 * story 4946 (the desktop app's chat list) — the menu a right-click on a room row opens: ONLY what the room's own «⋯» menu already has (mute · the notification settings), the same words — no new action.
 * Drawn the way the message menu is (`MessageContextMenu`: a fixed popup at the pointer, clamped into the window, closed by an outside press or Escape). The first item takes the focus so the keys
 * (↑ ↓ · Enter · Esc) work on it at once, and the row gets the focus back when it closes (the caller).
 */
export function RoomRowContextMenu({ x, y, muted, onToggleMute, onOpenSettings, onClose }: RoomRowContextMenuProps) {
  const t = useTranslations('chats');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  const menuW = 176; const menuH = 84;
  const estimated = { left: Math.min(x, window.innerWidth - menuW - 8), top: Math.min(y, window.innerHeight - menuH - 8) };
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [x, y]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const item = 'flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2 text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none';
  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="room-row-menu"
      onKeyDown={onKeyDown}
      className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-[var(--elev-overlay)]"
      style={estimated}
    >
      <button type="button" role="menuitem" data-testid="room-row-mute" onClick={() => { onToggleMute(); onClose(); }} className={item}>
        {muted ? <Bell className="h-3.5 w-3.5 text-muted-foreground" /> : <BellOff className="h-3.5 w-3.5 text-muted-foreground" />}
        {muted ? t('unmuteNotifications') : t('muteNotifications')}
      </button>
      <button type="button" role="menuitem" data-testid="room-row-settings" onClick={() => { onOpenSettings(); onClose(); }} className={item}>
        <Settings className="h-3.5 w-3.5 text-muted-foreground" />
        {t('deliveryContractTitle')}
      </button>
    </div>
  );
}
