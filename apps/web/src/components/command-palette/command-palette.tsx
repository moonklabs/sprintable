'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  BookOpen,
  CalendarRange,
  FolderKanban,
  Gauge,
  GitPullRequest,
  Lightbulb,
  List,
  Search,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { buildActionCommands, type ActionCommand } from './command-palette-actions';
import { useFlatHref } from '@/hooks/use-flat-href';
import { fetchWithAuth } from '@/lib/db/client';
import { NAV_GROUPS, CHAT_CENTER_ITEM, LEGACY_NAV_ITEMS } from '@/lib/nav-config';
import { pickEuroJosa } from '@/lib/korean-particle';

interface CommandItem {
  id: string;
  group: 'navigate';
  icon: LucideIcon;
  label: string;
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
  story_number?: number | null;
}

// story #3698(IA·후속, PO 確定 2026-09-08) — 사이드바 KbdHint(app-sidebar.tsx)와 같은
// 단축키를 파생 항목에도 이식한다(id 매칭 — NAV_GROUPS 자체엔 팔레트 전용 단축키 개념이
// 없다, kbdHint는 사이드바 표시용 다른 축이라 재사용 안 함).
const NAV_ITEM_SHORTCUTS: Record<string, string[]> = {
  inbox: ['G', 'I'],
  board: ['G', 'B'],
  chats: ['G', 'M'],
  'org-workforce': ['G', 'A'],
  docs: ['G', 'S'],
};

// story #2930 I3(PO 확定 2026-08-22)·#2931 — /sprints·/epics는 nav-config.ts NAV_GROUPS에
// 없는(S1에서 'board'가 flow+sprints를 흡수) 라우트지만, WorkspaceFrameTabs(flow/sprints
// 페이지 상단 프레임)가 router.push(템플릿 리터럴)로만 여는지라 verify-no-orphan-resource-
// routes(story #2376) 정적 스캔(㉠resourceLink류·㉡리터럴 href) 시야 밖이다. 이 두 리터럴이
// 그 가드의 유일하게 «보이는» 앵커다 — story #3698 그라운딩(PO 確定)으로 NAV_GROUPS 파생
// 대상이 «아니다»로 확定됐다. 지우지 말 것(지우면 그 가드가 조용히 눈먼다).
// story #3845(UX-v3·FE 5·일감 2, 페드루 PO 確定 §③ⓑ 2026-09-14) — 「회고」가 LEGACY_
// NAV_ITEMS(nav-config.ts)에서 빠지고 WorkspaceFrameTabs 전용 진입점(router.push 템플릿
// 리터럴)으로만 남으면 verify-no-orphan-resource-routes.ts의 ㉠조합 시야 밖이라(같은
// 파일 상단 주석 "지우지 말 것" 경고 그대로 — go-sprints 선례와 동형) go-retro 앵커가
// 없으면 조용한 orphan이 된다. 지우면 그 가드가 못 잡는다.
// story #4013 — export해 팔레트 정의를 직접 순회하는 가드(scripts/verify-command-
// palette-workspaceless-href-resolves.test.ts)가 이름 목록을 손으로 다시 안 베끼게 한다.
export const GUARD_ANCHOR_ITEMS: Array<{ id: string; icon: LucideIcon; labelKey: string; href: string }> = [
  { id: 'go-sprints', icon: CalendarRange, labelKey: 'goSprints', href: '/sprints' },
  { id: 'go-epics', icon: FolderKanban, labelKey: 'goEpics', href: '/epics' },
  { id: 'go-retro', icon: Gauge, labelKey: 'goRetro', href: '/retro' },
  // story #3844(PO 지적 2026-09-14 08:09Z, CI 「Verify no orphan resource routes(#2376)」
  // RED) — WorkspaceFrameTabs가 얹은 탭 경로는 이 가드가 진입점으로 안 센다(4264가 retro를
  // 여기 앵커한 선례 그대로) — work-list도 동형으로 앵커.
  { id: 'go-work-list', icon: List, labelKey: 'goWorkList', href: '/work-list' },
  // story #3989(「일감」 흡수 3/N) — 「가설」 탭도 WorkspaceFrameTabs 전용 진입점(router.push
  // 템플릿 리터럴)뿐이라 같은 이유로 앵커가 필요하다(go-work-list·go-retro 선례 그대로).
  { id: 'go-hypotheses', icon: Lightbulb, labelKey: 'goHypotheses', href: '/hypotheses' },
];

export interface DerivedNavItem {
  id: string;
  icon: LucideIcon;
  labelKey: string;
  href: string;
  /** label 계산식이 갈리는 축(아래 소비부 참고) — 'anchor'는 t(labelKey) 그대로,
   * 'nav'는 tNav(labelKey)에 goDestinationLabel("~로 이동" 접미사)을 씌운다. */
  labelSource: 'anchor' | 'nav';
  /** 워크스페이스 없는(작업공간·프로젝트 세그먼트가 안 붙는) 절대경로인지 — 가드가
   * 이 값이 true인 항목만 MIGRATED_RESOURCES/RENAMED_RESOURCES/실 page.tsx 대조 대상으로 삼는다. */
  isWorkspaceless: boolean;
}

// story #4013 CHANGES②(페드루 PO 지적 2026-09-17 12:57Z) — 최초판은 이 파생 로직을
// 컴포넌트 useMemo 안에 두고, 가드용 getWorkspacelessStaticNavItems()가 같은 소스를
// **따로** 다시 조립했다 — 상수만 같을 뿐 조립 코드가 둘이라 드리프트 위험이 여전했다.
// 이제 이 함수 하나가 유일한 조립처다: 컴포넌트의 ITEMS useMemo가 이 함수를 **호출**하고
// (아래), 가드는 이 함수의 결과에서 isWorkspaceless만 걸러 쓴다 — NAV_GROUPS.flatMap류
// 목록 조립은 이 함수 밖 어디에도 없다(그 사실 자체를 테스트가 grep으로 고정).
//
// resolveResourceHref는 orgSlug/currentProjectSlug 같은 런타임 상태에 기대므로 인자로
// 주입한다(이 파일을 순수하게 유지 — 가드 테스트가 더미 콜백으로도 부를 수 있어야 한다).
// 워크스페이스 없는 항목(isWorkspaceless=true)은 이 콜백을 아예 안 부른다 — 그래서 어떤
// 더미를 넣어도 실제 href(navItem.path 그대로)가 그대로 나온다.
export function deriveNavigateItems(resolveResourceHref: (resource: string) => string): DerivedNavItem[] {
  const navItems = [...NAV_GROUPS.flatMap((group) => group.items), ...LEGACY_NAV_ITEMS, CHAT_CENTER_ITEM];
  const fromNav: DerivedNavItem[] = navItems.map((navItem) => {
    // story #2224(선생님 정정 2026-07-30) — 'board'는 `/flow?view=list`로 흡수, 'docs'도
    // resourceHref 재계산 대상(둘 다 kind='static'이어도 워크스페이스 있는 경로로 오버라이드
    // — ⛔이 두 분기가 그 오버라이드의 유일한 정의처, 새 id를 추가하면 여기도 같이 반영할 것).
    if (navItem.id === 'board') {
      return {
        id: navItem.id, icon: navItem.icon, labelKey: navItem.labelKey,
        href: `${resolveResourceHref('flow')}?view=list`, labelSource: 'nav', isWorkspaceless: false,
      };
    }
    if (navItem.id === 'docs') {
      return {
        id: navItem.id, icon: navItem.icon, labelKey: navItem.labelKey,
        href: resolveResourceHref('docs'), labelSource: 'nav', isWorkspaceless: false,
      };
    }
    const isResource = navItem.kind === 'resource';
    return {
      id: navItem.id, icon: navItem.icon, labelKey: navItem.labelKey,
      href: isResource ? resolveResourceHref(navItem.path) : navItem.path,
      labelSource: 'nav', isWorkspaceless: !isResource,
    };
  });
  const fromAnchors: DerivedNavItem[] = GUARD_ANCHOR_ITEMS.map((anchor) => ({
    id: anchor.id, icon: anchor.icon, labelKey: anchor.labelKey, href: anchor.href,
    labelSource: 'anchor', isWorkspaceless: true,
  }));
  return [...fromNav, ...fromAnchors];
}

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
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const locale = useLocale();
  const t = useTranslations('commandPalette');
  const tNav = useTranslations('nav');
  // story #3698(IA·후속) — "{label}(으)로 이동" 조사는 한글 받침 유무를 따른다(맞춤법
  // 규칙, 어휘 판단 아님 — korean-particle.ts 참고). en 템플릿("Go to {label}")은 조사가
  // 없어 이 값을 안 쓴다(넘겨도 무해, ICU가 미사용 파라미터를 조용히 무시).
  function goDestinationLabel(label: string): string {
    return t('goDestination', { label, particle: locale === 'ko' ? pickEuroJosa(label) : '' });
  }
  const { orgId, orgMemberships, currentProjectSlug } = useDashboardContext();
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  function resourceHref(resource: string): string {
    return orgSlug && currentProjectSlug ? `/${orgSlug}/${currentProjectSlug}/${resource}` : `/${resource}`;
  }
  const docsHref = resourceHref('docs');
  // story #2224(선생님 정정 2026-07-30, 진입점 전수 스윕) — `/board` 라우트가 삭제되고
  // `/flow?view=list`로 흡수됐다(PR#2698). "보드로 이동" 라벨은 목적지 콘텐츠(칸반)가
  // 그대로라 안 바꿨지만, href는 최종 주소를 직접 가리켜야 한다(리다이렉트 경유는 "은퇴한
  // 주소가 진입점에 살아 있다"는 문제를 남긴다). 쿼리 없는 bare href로 두고 각 사용처가
  // 자기 쿼리를 직접 이어붙인다(actionItems가 story= 이어붙일 때 `?`가 두 번 생기면 안 됨).
  // deriveNavigateItems()도 'board' id에 이 식과 동일한 조립(resourceHref('flow')+
  // '?view=list')을 쓴다(그 함수 안 주석 참고) — actionItems는 팔레트 navigate 목록 밖
  // 별도 소비처라 이 변수를 그대로 유지한다(사본 아님, 서로 다른 소비처의 같은 상수).
  const boardHref = `${resourceHref('flow')}?view=list`;
  // story #3698(IA·후속, PO 確定 2026-09-08) — navigate 목적지를 NAV_GROUPS(+CHAT_CENTER_
  // ITEM)에서 파생한다(하드코딩 7→전수 25). 라벨·경로는 nav-config.ts 단일 정본 재사용
  // (사본 0) — 사이드바에 있는 목적지는 전부 ⌘K로도 도달한다(S4 AC2 실충족). go-sprints·
  // go-epics만 위 GUARD_ANCHOR_ITEMS로 별도 유지(가드 앵커, 파생 대상 아님).
  //
  // story #3824(UX-v3·FE 1, 2026-09-13) — LEGACY_NAV_ITEMS(사이드바 5항목 축소로 빠진
  // 17개)도 같은 파생 파이프라인에 얹는다 — 사이드바엔 없어도 ⌘K가 이들의 1급 진입점이라는
  // 카드 AC2를 이 한 줄로 충족한다(전용 하드코딩 목록을 새로 만들지 않는다).
  //
  // story #4013 CHANGES②(페드루 PO 지적 2026-09-17 12:57Z) — 목록 조립 자체를 컴포넌트
  // 밖 deriveNavigateItems()로 옮겨 가드 테스트와 같은 함수를 부른다(이 useMemo 안엔
  // NAV_GROUPS.flatMap류 조립이 다시 없다 — verify-command-palette-workspaceless-href-
  // resolves.test.ts가 grep으로 그 사실 자체를 고정).
  const ITEMS = useMemo<CommandItem[]>(() => {
    return deriveNavigateItems(resourceHref).map((item) => ({
      id: item.id,
      group: 'navigate' as const,
      icon: item.icon,
      label: item.labelSource === 'anchor' ? t(item.labelKey) : goDestinationLabel(tNav(item.labelKey)),
      // story #4231 — 워크스페이스 없는(flat) 목적지는 사이드바·더보기와 같이 현재 프로젝트(`?p=`)를 싣는다.
      href: item.isWorkspaceless ? flatHref(item.href) : item.href,
      shortcut: NAV_ITEM_SHORTCUTS[item.id],
    }));
    // resourceHref는 orgSlug·currentProjectSlug의 순수 파생(그 값들이 이미 deps에 있음) —
    // 함수 참조 자체를 deps에 넣으면 매 렌더 새로 만들어져 메모가 무의미해진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, currentProjectSlug, t, tNav, locale, flatHref]);
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
        const res = await fetchWithAuth(`/api/stories/${contextStoryId}`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: { id: string; title: string; story_number?: number | null } };
        if (!cancelled && json.data) setContextStory({ id: json.data.id, title: json.data.title, story_number: json.data.story_number });
      } catch { /* no-fiction: 조회 실패면 그냥 context 없음과 동일 취급 */ }
    })();
    return () => { cancelled = true; };
  }, [open, contextStoryId]);

  const actionItems = useMemo(
    () => buildActionCommands(t, flatHref, contextStory ? { storyId: contextStory.id, storyTitle: contextStory.title, boardHref } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t는 로케일 불변 함수
    [contextStory, boardHref],
  );

  const filteredNavigate = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    return ITEMS.filter((item) => item.label.toLowerCase().includes(q));
  }, [query, ITEMS]);

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
        const res = await fetchWithAuth(`/api/docs?project_id=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q)}&limit=5`);
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
    router.push(`${docsHref}/${doc.slug}`);
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
            // story #3007(로드맵 P2·PR-E, L1) — cmd palette 다이얼로그는 floating이라 --elev-overlay.
            'overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-[var(--elev-overlay)] ring-1 ring-foreground/10',
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
              {t('contextChip', { title: contextStory.story_number ? `#${contextStory.story_number} ${contextStory.title}` : contextStory.title })}
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
}

function CommandGroup({ label, items, start, activeIndex, onSelect }: CommandGroupProps) {
  return (
    <div className="flex flex-col" data-command-group="navigate">
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
                data-command-id={item.id}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{item.label}</span>
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
                data-command-id={item.id}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{item.label}</span>
                {item.danger ? (
                  // story #2590(TIER1) — tint 위 계열색 글자는 text-foreground(#2420 규칙).
                  <span className="ml-auto shrink-0 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold text-foreground">
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
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate">{doc.icon ? `${doc.icon} ` : ''}{doc.title}</span>
                  {/* story #2167 AC2 — slug로 찾은 결과가 어떤 slug인지 화면에 보여야 한다. */}
                  <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">{doc.slug}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
