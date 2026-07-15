'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  BookOpen,
  Bot,
  CalendarRange,
  FolderKanban,
  GitPullRequest,
  Inbox,
  LayoutDashboard,
  MessageSquareMore,
  Search,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildActionCommands, type ActionCommand } from './command-palette-actions';

interface CommandItem {
  id: string;
  group: 'navigate';
  icon: LucideIcon;
  labelKey: string;
  href: string;
  shortcut?: string[];
}

interface DocResult {
  id: string;
  title: string;
  slug: string;
  icon: string | null;
}

interface StoryTitleResult {
  id: string;
  title: string;
}

const ITEMS: CommandItem[] = [
  { id: 'go-inbox', group: 'navigate', icon: Inbox, labelKey: 'goInbox', href: '/inbox', shortcut: ['G', 'I'] },
  { id: 'go-dashboard', group: 'navigate', icon: LayoutDashboard, labelKey: 'goDashboard', href: '/dashboard', shortcut: ['G', 'D'] },
  { id: 'go-board', group: 'navigate', icon: FolderKanban, labelKey: 'goBoard', href: '/board', shortcut: ['G', 'B'] },
  { id: 'go-sprints', group: 'navigate', icon: CalendarRange, labelKey: 'goSprints', href: '/sprints' },
  { id: 'go-chats', group: 'navigate', icon: MessageSquareMore, labelKey: 'goChats', href: '/chats', shortcut: ['G', 'M'] },
  { id: 'go-agents', group: 'navigate', icon: Bot, labelKey: 'goAgents', href: '/organization/workforce', shortcut: ['G', 'A'] },
  { id: 'go-docs', group: 'navigate', icon: BookOpen, labelKey: 'goDocs', href: '/docs', shortcut: ['G', 'S'] },
];

// 명령(action)당 아이콘 — command-palette-actions.ts는 순수 데이터만 다뤄 lucide 컴포넌트를
// 안 들고 있으므로 여기서 labelKey로 매핑.
const ACTION_ICONS: Record<ActionCommand['labelKey'], LucideIcon> = {
  actionDelegateStory: UserPlus,
  actionGateDecision: GitPullRequest,
  actionRecruitAgent: Users,
};

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  /** ⌘K 액션 확장(story 4f991165) — 현재 스토리 상세(`/board?story={id}`)에서 열렸을 때만
   * 주입. 없으면 "이 스토리를 위임" 명령은 유효한 대상이 없어 인벤토리에서 생략(no-fiction). */
  contextStoryId?: string;
}

export function CommandPalette({ open, onOpenChange, projectId, contextStoryId }: CommandPaletteProps) {
  const router = useRouter();
  const t = useTranslations('commandPalette');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [docResults, setDocResults] = useState<DocResult[]>([]);
  const [contextStory, setContextStory] = useState<StoryTitleResult | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // context 스토리 제목 lazy 조회 — 열릴 때만, contextStoryId 있을 때만(1콜).
  useEffect(() => {
    if (!open || !contextStoryId) { setContextStory(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/stories/${contextStoryId}`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { id: string; title: string } };
        if (!cancelled && json.data) setContextStory({ id: json.data.id, title: json.data.title });
      } catch { /* no-fiction: 조회 실패면 그냥 context 없음과 동일 취급 */ }
    })();
    return () => { cancelled = true; };
  }, [open, contextStoryId]);

  const actionItems = useMemo(
    () => buildActionCommands(t, contextStory ? { storyId: contextStory.id, storyTitle: contextStory.title } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t는 로케일 불변 함수
    [contextStory],
  );

  const filteredNavigate = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter((item) => t(item.labelKey).toLowerCase().includes(q));
  }, [query, t]);

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actionItems;
    return actionItems.filter((item) => item.label.toLowerCase().includes(q));
  }, [query, actionItems]);

  // Docs search with debounce
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q || !projectId) {
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/docs?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=5`);
        if (!res.ok) return;
        const json = await res.json() as { data?: DocResult[] };
        setDocResults(json.data ?? []);
      } catch {
        // ignore network errors
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, projectId]);

  // Gate doc results on active query to avoid showing stale results
  const displayedDocResults = useMemo(() => query.trim() ? docResults : [], [query, docResults]);

  // 그룹 순서 — story context 있으면 "이 스토리 명령"이 위로 랭크(doc §3): action 그룹이
  // navigate 위로. context 없으면 기존 순서 그대로(회귀 0).
  const sections = useMemo(() => {
    const groups: Array<{ key: 'navigate' | 'action' | 'doc'; items: CommandItem[] | ActionCommand[] | DocResult[] }> = contextStory
      ? [{ key: 'action', items: filteredActions }, { key: 'navigate', items: filteredNavigate }, { key: 'doc', items: displayedDocResults }]
      : [{ key: 'navigate', items: filteredNavigate }, { key: 'action', items: filteredActions }, { key: 'doc', items: displayedDocResults }];
    let offset = 0;
    return groups.map((g) => {
      const start = offset;
      offset += g.items.length;
      return { ...g, start };
    });
  }, [contextStory, filteredActions, filteredNavigate, displayedDocResults]);

  const totalCount = sections.reduce((sum, s) => sum + s.items.length, 0);
  const clampedActiveIndex = totalCount === 0 ? 0 : Math.min(Math.max(activeIndex, 0), totalCount - 1);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery('');
      setActiveIndex(0);
      setDocResults([]);
    }
    onOpenChange(next);
  }

  function handleSelectNav(item: CommandItem) {
    router.push(item.href);
    handleOpenChange(false);
  }

  function handleSelectAction(item: ActionCommand) {
    router.push(item.targetRoute);
    handleOpenChange(false);
  }

  function handleSelectDoc(doc: DocResult) {
    router.push(`/docs/${doc.slug}`);
    handleOpenChange(false);
  }

  function selectAtIndex(index: number) {
    const section = sections.find((s) => index >= s.start && index < s.start + s.items.length);
    if (!section) return;
    const localIndex = index - section.start;
    if (section.key === 'navigate') handleSelectNav(section.items[localIndex] as CommandItem);
    else if (section.key === 'action') handleSelectAction(section.items[localIndex] as ActionCommand);
    else handleSelectDoc(section.items[localIndex] as DocResult);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(Math.min(totalCount - 1, clampedActiveIndex + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(Math.max(0, clampedActiveIndex - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectAtIndex(clampedActiveIndex);
    }
  }

  const hasResults = totalCount > 0;

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

          {contextStory ? (
            <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
              <span className="text-info" aria-hidden="true">◆</span>
              {t('contextChip', { title: contextStory.title })}
            </div>
          ) : null}

          <div ref={listRef} className="max-h-80 overflow-y-auto p-2">
            {!hasResults ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('noResults')}
              </div>
            ) : (
              sections.map((section) => {
                if (section.items.length === 0) return null;
                if (section.key === 'navigate') {
                  return (
                    <CommandGroup
                      key="navigate"
                      label={t('navigate')}
                      items={section.items as CommandItem[]}
                      activeIndex={clampedActiveIndex}
                      start={section.start}
                      onSelect={handleSelectNav}
                      t={t}
                    />
                  );
                }
                if (section.key === 'action') {
                  return (
                    <ActionGroup
                      key="action"
                      label={t('actions')}
                      items={section.items as ActionCommand[]}
                      activeIndex={clampedActiveIndex}
                      start={section.start}
                      onSelect={handleSelectAction}
                      dangerPillLabel={t('actionDangerPill')}
                    />
                  );
                }
                return (
                  <DocGroup
                    key="doc"
                    label={t('documents')}
                    docs={section.items as DocResult[]}
                    activeIndexOffset={section.start}
                    activeIndex={clampedActiveIndex}
                    onSelect={handleSelectDoc}
                  />
                );
              })
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
  start: number;
  activeIndex: number;
  onSelect: (item: CommandItem) => void;
  t: (key: string) => string;
}

function CommandGroup({ label, items, start, activeIndex, onSelect, t }: CommandGroupProps) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <ul className="flex flex-col">
        {items.map((item, i) => {
          const active = start + i === activeIndex;
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item)}
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

interface ActionGroupProps {
  label: string;
  items: ActionCommand[];
  start: number;
  activeIndex: number;
  onSelect: (item: ActionCommand) => void;
  dangerPillLabel: string;
}

/**
 * 명령(action) 그룹(story 4f991165) — route-first: 선택하면 인라인 뮤테이션이 아니라 맥락
 * 세팅된 실존 표면으로 딥링크만 한다. 활성 항목 아래에 영향 범위 프리뷰(약속 언어)를 렌더 —
 * 위험 명령(승인/반려)은 amber pill로만 표시(red는 진짜 kill 전용, learning-signal 규율).
 * 감시 금지: 명령 실행 이력/횟수/최근 사용 시각을 렌더하지 않는다.
 */
function ActionGroup({ label, items, start, activeIndex, onSelect, dangerPillLabel }: ActionGroupProps) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <ul className="flex flex-col">
        {items.map((item, i) => {
          const active = start + i === activeIndex;
          const Icon = ACTION_ICONS[item.labelKey];
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
                )}
                data-active={active || undefined}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{item.label}</span>
                {item.danger ? (
                  <span className="ml-auto shrink-0 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-warning">
                    {dangerPillLabel}
                  </span>
                ) : null}
              </button>
              {active ? (
                <p className="ml-8 mr-2 border-l-2 border-info/40 py-1 pl-2 text-[11px] leading-snug text-muted-foreground">
                  {item.impact}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface DocGroupProps {
  label: string;
  docs: DocResult[];
  activeIndexOffset: number;
  activeIndex: number;
  onSelect: (doc: DocResult) => void;
}

function DocGroup({ label, docs, activeIndexOffset, activeIndex, onSelect }: DocGroupProps) {
  return (
    <div className="flex flex-col">
      <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <ul className="flex flex-col">
        {docs.map((doc, i) => {
          const active = activeIndexOffset + i === activeIndex;
          return (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => onSelect(doc)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                  active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
                )}
                data-active={active || undefined}
              >
                <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{doc.icon ? `${doc.icon} ` : ''}{doc.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
