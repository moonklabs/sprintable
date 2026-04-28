'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  BookOpen,
  Bot,
  FolderKanban,
  Inbox,
  LayoutDashboard,
  MessageSquareMore,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface CommandItem {
  id: string;
  group: 'navigate';
  icon: LucideIcon;
  labelKey: string;
  href: string;
  shortcut?: string[];
}

const ITEMS: CommandItem[] = [
  { id: 'go-inbox', group: 'navigate', icon: Inbox, labelKey: 'goInbox', href: '/inbox', shortcut: ['G', 'I'] },
  { id: 'go-dashboard', group: 'navigate', icon: LayoutDashboard, labelKey: 'goDashboard', href: '/dashboard', shortcut: ['G', 'D'] },
  { id: 'go-board', group: 'navigate', icon: FolderKanban, labelKey: 'goBoard', href: '/board', shortcut: ['G', 'B'] },
  { id: 'go-memos', group: 'navigate', icon: MessageSquareMore, labelKey: 'goMemos', href: '/memos', shortcut: ['G', 'M'] },
  { id: 'go-agents', group: 'navigate', icon: Bot, labelKey: 'goAgents', href: '/agents', shortcut: ['G', 'A'] },
  { id: 'go-docs', group: 'navigate', icon: BookOpen, labelKey: 'goDocs', href: '/docs', shortcut: ['G', 'S'] },
];

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const t = useTranslations('commandPalette');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter((item) => t(item.labelKey).toLowerCase().includes(q));
  }, [query, t]);

  // Clamp active index to filtered range during render (avoid cascading effects).
  const clampedActiveIndex =
    filtered.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), filtered.length - 1);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery('');
      setActiveIndex(0);
    }
    onOpenChange(next);
  }

  function handleSelect(item: CommandItem) {
    router.push(item.href);
    handleOpenChange(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(Math.min(filtered.length - 1, clampedActiveIndex + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(Math.max(0, clampedActiveIndex - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = filtered[clampedActiveIndex];
      if (item) handleSelect(item);
    }
  }

  const navigateItems = filtered.filter((item) => item.group === 'navigate');

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-50 bg-black/20 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Popup
          className={cn(
            'fixed top-[20%] left-1/2 z-50 w-full max-w-[calc(100%-2rem)] -translate-x-1/2',
            'overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10',
            'sm:max-w-xl outline-none',
            'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95',
            'data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          )}
        >
          <DialogPrimitive.Title className="sr-only">{t('title')}</DialogPrimitive.Title>

          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('placeholder')}
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label={t('placeholder')}
            />
            <DialogPrimitive.Close
              className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('close')}
            >
              ESC
            </DialogPrimitive.Close>
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('noResults')}
              </div>
            ) : (
              navigateItems.length > 0 && (
                <CommandGroup
                  label={t('navigate')}
                  items={navigateItems}
                  activeIndex={clampedActiveIndex}
                  filteredItems={filtered}
                  onSelect={handleSelect}
                  t={t}
                />
              )
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface CommandGroupProps {
  label: string;
  items: CommandItem[];
  filteredItems: CommandItem[];
  activeIndex: number;
  onSelect: (item: CommandItem) => void;
  t: (key: string) => string;
}

function CommandGroup({ label, items, filteredItems, activeIndex, onSelect, t }: CommandGroupProps) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <ul className="flex flex-col">
        {items.map((item) => {
          const idx = filteredItems.indexOf(item);
          const active = idx === activeIndex;
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                onMouseEnter={() => {
                  /* hover does not change activeIndex to avoid mouse/keyboard fight */
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
                )}
                data-active={active || undefined}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{t(item.labelKey)}</span>
                {item.shortcut ? (
                  <span className="ml-auto flex items-center gap-1">
                    {item.shortcut.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
