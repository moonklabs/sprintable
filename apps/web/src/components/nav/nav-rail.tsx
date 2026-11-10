'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ALL_SCREENS_ITEM, CHAT_CENTER_ITEM, resolveNavGroups, type NavGroupConfig, type NavItemConfig } from '@/lib/nav-config';
import { findActiveStaticItemId, isResourceItemActive } from '@/lib/nav-active';
import { DEFAULT_NAV_V3_FLAGS, scopedResourceHref, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';
import { useFlatHref } from '@/hooks/use-flat-href';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { CountBadge } from '@/components/ds/count-badge';
import { RAIL_ICON_BY_ITEM_ID } from './rail-icons';
import { RailAccount } from './rail-account';
import type { OrgSwitcherItem } from './unified-switcher';
import type { DashboardProjectOption } from '@/app/dashboard/dashboard-shell';

// story #4885 (UI-2) — **B 셸 초안**: 안 B «프로토콜»(아이콘 막대 + 목록 + 상세)의 아이콘 막대. 유나 UI-1 §6 B 줄: 매일 다섯 = 막대 위쪽 아이콘 · 조직 묶음 = 막대의 «조직» 아이콘을 누르면 옆으로 펼침 · 설정 · 전체 = 막대 맨 아래.
// 이 파일은 **그리는 쪽만**이다: 무엇이 있는지(구역 · 항목 · 이름 · 경로 · 배지 종류)는 nav-config.ts, «지금 여기»는 nav-active.ts — 왼쪽 길잡이(app-sidebar.tsx)와 같은 데이터 · 같은 판정을 읽는다.
// 셸에 끼웠다(dashboard-shell.tsx ShellBody · lg 이상만 — 폰·태블릿 세로는 하단 탭). 선생님 11-10 17시 테마 결정 = B 계열.
// 모양은 UI-3 첫 판(`--ds-*` 토큰 · `components/ds/icon`)으로 입혔다 — 색 · 모서리 · 글자 눈금은 `ds-*` 이름만 쓰고(시험이 옛 색 클래스 0을 지킨다), 아이콘은 Material Symbols(항목 id → 글리프 한 표: rail-icons.ts).
//
// 규칙
//  · 매일 구역(오늘 · 일감 · 에이전트/팀 · 지식)마다 아이콘 하나 = 그 구역 첫 항목으로 가는 링크. 구역에 항목이 더 있으면(오늘의 결재 · 일감의 목표 · 실행 · 에이전트의 실행 기록 · API 키 · 지식의 산출물 · 스토리지) 아이콘에 올리거나 초점을 주면 옆에 목록이 뜬다.
//  · «대화» 카드(구역 밖 1급)는 «오늘» 바로 뒤. «조직» 아이콘은 막대 아래쪽 — 누르면 조직 항목 전부가 옆으로 펼쳐지고 Esc · 바깥 누름으로 닫힌다.
//  · 맨 아래: 찾기(⌘K) · 설정 · 전체. 건수 배지: «오늘» 아이콘 = 호출부가 넘기는 todayCount(셈은 UI-5), «대화» 아이콘 = 안 읽은 수.
export interface NavRailProps {
  orgSlug?: string;
  projectSlug?: string;
  /** «계정» 팝오버(길잡이 머리 · 바닥의 쪽이 아닌 입구)에 넘기는 값 — 길잡이와 같은 출처. 안 넘기면 «계정» 아이콘은 그리지 않는다(시험 · 단독 사용). */
  account?: { orgId?: string; orgMemberships: OrgSwitcherItem[]; projectId?: string; projectMemberships: DashboardProjectOption[]; userName?: string };
  navV3Flags?: NavV3Flags;
  /**
   * «오늘» 아이콘의 건수 — **받아서 그리기만 한다**. 무엇을 세는지(결재 · 답 · 멘션 · 알림의 합 = 오늘 화면 «내 손이 필요해요» 구역 건수)는 담롱군 UI-5(오늘 화면)가 정하고, 호출부가 그 값을 넘긴다
   * (UI-1 §6 ① — 웹 길잡이 · 폰 하단 탭 · 이 막대의 «오늘» 배지가 한 숫자). 이음새는 이 prop 하나뿐이라 셈이 바뀌어도 이 파일은 안 바뀐다.
   */
  todayCount?: number;
  chatUnreadTotal?: number;
  onOpenPalette?: () => void;
  /** 목록 칸(왼쪽 길잡이) 접기·펴기 — 목록 칸의 가장자리 손잡이(SidebarRail)가 막대 뒤에 가려지므로 막대가 자기 단추를 갖는다(codex P1). 안 넘기면 단추 없음. */
  listColumn?: { open: boolean; onToggle: () => void };
}

const DAILY_GROUP_IDS = ['now', 'dev', 'team', 'knowledge'] as const;

// 막대 단추 공통 모양(UI-3 §3: 모서리 control 4 · 호버 surface-high · 초점 링 action). 링크는 RAIL_LINK, 눌러서 여는 단추는 디자인 Button 위에 RAIL_BUTTON.
const RAIL_LINK = 'relative block rounded-ds-control hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action';
const RAIL_BUTTON = 'relative block h-auto min-h-0 min-w-0 rounded-ds-control p-0 hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action';
// 옆으로 뜨는 목록 상자: 한 단계 올린 면 + 헤어라인 · 모서리 panel 8 · 그림자 0(UI-3 §1 카드).
const FLYOUT_PANEL = 'absolute z-30 flex flex-col gap-0.5 rounded-ds-panel border border-ds-line bg-ds-surface-raised p-1';

export function NavRail({ orgSlug, projectSlug, account, listColumn, navV3Flags = DEFAULT_NAV_V3_FLAGS, todayCount = 0, chatUnreadTotal = 0, onOpenPalette }: NavRailProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const flatHref = useFlatHref();
  const groups = useMemo(() => resolveNavGroups(navV3Flags), [navV3Flags]);
  const staticItems = useMemo(() => [...groups.flatMap((g) => g.items), CHAT_CENTER_ITEM, ALL_SCREENS_ITEM] as NavItemConfig[], [groups]);
  const activeStaticId = findActiveStaticItemId(staticItems, pathname, searchParams);

  const link = (item: Pick<NavItemConfig, 'id' | 'kind' | 'path'>) => ({
    href: item.kind === 'static' ? flatHref(item.path) : scopedResourceHref(item.path, orgSlug, projectSlug, flatHref),
    isActive: item.kind === 'static' ? item.id === activeStaticId : isResourceItemActive(pathname, item.path, orgSlug, projectSlug, item.id === 'board' ? WORKSPACE_FRAME_TAB_PATHS : []),
  });

  const [orgOpen, setOrgOpen] = useState(false);
  const orgRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!orgOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOrgOpen(false); };
    const onDown = (e: MouseEvent) => { if (orgRef.current && !orgRef.current.contains(e.target as Node)) setOrgOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [orgOpen]);

  const byId = (id: string) => groups.find((g) => g.id === id) as NavGroupConfig | undefined;
  const orgGroup = byId('org');
  const settingsItem = byId('settings')?.items[0];
  // 설정 묶음의 어느 항목이든(데스크톱 앱 등) 켜지면 막대의 설정 아이콘이 켜진다(codex P3) — 묶음 전체로 본다.
  const settingsActive = Boolean(byId('settings')?.items.some((i) => link(i).isActive));
  const orgHasActive = Boolean(orgGroup?.items.some((i) => link(i).isActive));


  // 아이콘 한 칸(40px). 켜짐 = action-soft 바탕 + action-text 글(선택 표시는 action 계열), 꺼짐 = ink-3. 호버 바탕은 링크 쪽(RAIL_LINK)이 입힌다.
  const railIcon = (id: string, active: boolean) => (
    <span className={cn('flex size-10 items-center justify-center rounded-ds-control transition-colors', active ? 'bg-ds-action-soft text-ds-action-text' : 'text-ds-ink-3')}>
      <Icon name={RAIL_ICON_BY_ITEM_ID[id]!} size={20} className="size-5" />
    </span>
  );
  // 건수 배지 = ds CountBadge(UI-3 §4 #6 · 한 모양 · 색은 뜻 둘): 읽지 않음(대화) = action / 내 손 필요(홈) = needs-hand-bar + on-needs-hand 글자. 손 필요는 «안 보이는 이름»이 필수(색만으로 뜻을 싣지 않는다).
  // 링크의 aria-label이 이름을 덮으므로 건수 > 0이면 링크 이름에 «이름 · 건수 뜻 N»을 싣는다(ariaName) — 배지 안 sr-only 글만으로는 스크린리더가 못 읽는다.
  const badge = (n: number, tone: 'unread' | 'needs-hand') => (n > 0 ? (
    tone === 'needs-hand'
      ? <CountBadge kind="needs-hand" label={t('railNeedsHand')} count={n} className="absolute -right-0.5 -top-0.5" data-testid="rail-badge" />
      : <CountBadge kind="unread" label={t('railUnread')} count={n} className="absolute -right-0.5 -top-0.5" data-testid="rail-badge" />
  ) : null);
  const ariaName = (base: string, n: number, tone: 'unread' | 'needs-hand') => (n > 0 ? `${base} · ${t(tone === 'needs-hand' ? 'railNeedsHand' : 'railUnread')} ${n}` : base);

  const dailyEntry = (group: NavGroupConfig) => (
    <DailyEntry key={group.id} group={group} link={link} label={(item) => t(item.labelKey)} groupLabel={group.labelKey ? t(group.labelKey) : undefined} icon={railIcon} badge={badge} ariaName={ariaName} count={group.id === 'now' ? todayCount : 0} tone="needs-hand" />
  );

  const chatLink = link(CHAT_CENTER_ITEM);
  const dailyGroups = DAILY_GROUP_IDS.map(byId).filter((g): g is NavGroupConfig => Boolean(g));

  return (
    <nav aria-label={t('workspace')} className="sticky top-0 z-20 hidden h-svh w-14 shrink-0 flex-col items-center gap-1 border-r border-ds-line bg-ds-surface py-2 lg:flex" data-testid="nav-rail">
      {dailyGroups.slice(0, 1).map(dailyEntry)}
      <Link href={chatLink.href} aria-label={ariaName(t(CHAT_CENTER_ITEM.labelKey), chatUnreadTotal, 'unread')} title={t(CHAT_CENTER_ITEM.labelKey)} aria-current={chatLink.isActive ? 'page' : undefined} className={RAIL_LINK} data-rail-item={CHAT_CENTER_ITEM.id}>
        {railIcon(CHAT_CENTER_ITEM.id, chatLink.isActive)}
        {badge(chatUnreadTotal, 'unread')}
      </Link>
      {dailyGroups.slice(1).map(dailyEntry)}

      <div className="mt-auto flex flex-col items-center gap-1">
        {orgGroup ? (
          <div ref={orgRef} className="relative" data-rail-group="org">
            <Button type="button" variant="ghost" aria-label={t('zoneOrganization')} title={t('zoneOrganization')} aria-expanded={orgOpen} aria-haspopup="true" onClick={() => setOrgOpen((v) => !v)} className={RAIL_BUTTON} data-rail-item="org">
              {railIcon('org', orgOpen || orgHasActive)}
            </Button>
            {orgOpen ? (
              <ul role="list" className={cn(FLYOUT_PANEL, 'bottom-0 left-full ml-1 min-w-52')} data-testid="rail-org-panel">
                {orgGroup.items.map((item) => <FlyoutLink key={item.id} item={item} href={link(item).href} active={link(item).isActive} label={t(item.labelKey)} onNavigate={() => setOrgOpen(false)} />)}
              </ul>
            ) : null}
          </div>
        ) : null}
        {listColumn ? (
          <Button type="button" variant="ghost" aria-label={t('toggleSidebar')} title={t('toggleSidebar')} aria-expanded={listColumn.open} onClick={listColumn.onToggle} className={RAIL_BUTTON} data-rail-item="list-column-toggle">
            {railIcon('list-column-toggle', false)}
          </Button>
        ) : null}
        {account ? <RailAccount {...account} /> : null}
        <Button type="button" variant="ghost" aria-label={t('search')} title={`${t('search')} ⌘K`} onClick={onOpenPalette} className={RAIL_BUTTON} data-rail-item="search">
          {railIcon('search', false)}
        </Button>
        {settingsItem ? (
          <Link href={link(settingsItem).href} aria-label={t(settingsItem.labelKey)} title={t(settingsItem.labelKey)} aria-current={settingsActive ? 'page' : undefined} className={RAIL_LINK} data-rail-item={settingsItem.id}>
            {railIcon(settingsItem.id, settingsActive)}
          </Link>
        ) : null}
        <Link href={flatHref(ALL_SCREENS_ITEM.path)} aria-label={t(ALL_SCREENS_ITEM.labelKey)} title={t(ALL_SCREENS_ITEM.labelKey)} aria-current={activeStaticId === ALL_SCREENS_ITEM.id ? 'page' : undefined} className={RAIL_LINK} data-rail-item={ALL_SCREENS_ITEM.id}>
          {railIcon(ALL_SCREENS_ITEM.id, activeStaticId === ALL_SCREENS_ITEM.id)}
        </Link>
      </div>
    </nav>
  );
}

// 매일 구역 하나 = 아이콘 링크 하나(구역 첫 항목) + 항목이 더 있으면 옆에 뜨는 목록. 목록은 호버 · 키보드 초점 · (Esc로 닫힘)이 상태로 열고 닫는다 —
// CSS 호버만으로 열면(group-hover) 터치에서는 닿지 않는 조작 요소 부류(hover-reveal 가드)가 되므로, 열림을 상태로 쥐고 `hidden`은 닫힘일 때만 쓴다.
function DailyEntry({ group, link, label, groupLabel, icon, badge, ariaName, count, tone }: {
  group: NavGroupConfig;
  link: (item: Pick<NavItemConfig, 'id' | 'kind' | 'path'>) => { href: string; isActive: boolean };
  label: (item: NavItemConfig) => string;
  /** 머리글 있는 구역(팀 · 지식)의 아이콘은 첫 항목 이름(구성원 · 문서)이 아니라 구역 이름으로 부른다 */
  groupLabel?: string;
  icon: (id: string, active: boolean) => ReactNode;
  badge: (n: number, tone: 'unread' | 'needs-hand') => ReactNode;
  ariaName: (base: string, n: number, tone: 'unread' | 'needs-hand') => string;
  count: number;
  tone: 'unread' | 'needs-hand';
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLAnchorElement | null>(null);
  // Esc가 목록 안 링크에서 초점을 아이콘으로 «옮길» 때만, 그 초점이 목록을 다시 열지 않게 한 번 건너뛴다(아이콘에서 Esc면 초점이 안 움직이므로 표지를 세우지 않는다).
  const escapedRef = useRef(false);
  const [first, ...rest] = group.items;
  if (!first) return null;
  const firstLink = link(first);
  const anyActive = group.items.some((i) => link(i).isActive);
  return (
    <div
      className="relative"
      data-rail-group={group.id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => { if (escapedRef.current) { escapedRef.current = false; return; } setOpen(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); const trigger = triggerRef.current; if (trigger && document.activeElement !== trigger) { escapedRef.current = true; trigger.focus(); } } }}
    >
      <Link ref={triggerRef} href={firstLink.href} aria-label={ariaName(groupLabel ?? label(first), count, tone)} title={groupLabel ?? label(first)} aria-current={anyActive ? 'page' : undefined} className={RAIL_LINK} data-rail-item={first.id}>
        {icon(first.id, anyActive)}
        {badge(count, tone)}
      </Link>
      {rest.length > 0 ? (
        // 아이콘과 목록 사이에 빈틈이 없어야 한다(codex P1): 바깥 상자의 왼쪽 padding이 그 틈을 «목록의 일부»로 메워, 마우스가 아이콘에서 목록으로 건너가는 동안 그룹의 mouseleave가 안 난다.
        <div className={cn('absolute left-full top-0 z-30 pl-1', open ? 'block' : 'hidden')} data-testid="rail-flyout" data-open={open}>
          <ul role="list" className="flex min-w-44 flex-col gap-0.5 rounded-ds-panel border border-ds-line bg-ds-surface-raised p-1">
            {group.items.map((item) => <FlyoutLink key={item.id} item={item} href={link(item).href} active={link(item).isActive} label={label(item)} />)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FlyoutLink({ item, href, active, label, onNavigate }: { item: NavItemConfig; href: string; active: boolean; label: string; onNavigate?: () => void }) {
  return (
    <li>
      <Link href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-2 rounded-ds-control px-2 py-1.5 text-ds-body hover:bg-ds-surface-high hover:text-ds-ink focus-visible:ring-2 focus-visible:ring-ds-action', active ? 'bg-ds-action-soft font-semibold text-ds-action-text' : 'text-ds-ink-2')} data-flyout-item={item.id}>
        <Icon name={RAIL_ICON_BY_ITEM_ID[item.id]!} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
    </li>
  );
}
