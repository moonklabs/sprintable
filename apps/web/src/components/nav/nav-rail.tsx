'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, LayoutGrid, MessageSquare, Search, type LucideIcon } from 'lucide-react';
import { ALL_SCREENS_ITEM, CHAT_CENTER_ITEM, resolveNavGroups, type NavGroupConfig, type NavItemConfig } from '@/lib/nav-config';
import { findActiveStaticItemId, isResourceItemActive } from '@/lib/nav-active';
import { DEFAULT_NAV_V3_FLAGS, scopedResourceHref, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { WORKSPACE_FRAME_TAB_PATHS } from '@/components/workspace/workspace-frame-tabs';
import { useFlatHref } from '@/hooks/use-flat-href';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// story #4885 (UI-2) — **B 셸 초안**: 안 B «프로토콜»(아이콘 막대 + 목록 + 상세)의 아이콘 막대. 유나 UI-1 §6 B 줄: 매일 다섯 = 막대 위쪽 아이콘 · 조직 묶음 = 막대의 «조직» 아이콘을 누르면 옆으로 펼침 · 설정 · 전체 = 막대 맨 아래.
// 이 파일은 **그리는 쪽만**이다: 무엇이 있는지(구역 · 항목 · 이름 · 경로 · 배지 종류)는 nav-config.ts, «지금 여기»는 nav-active.ts — 왼쪽 길잡이(app-sidebar.tsx)와 같은 데이터 · 같은 판정을 읽는다.
// 셸에 끼웠다(dashboard-shell.tsx ShellBody · lg 이상만 — 폰·태블릿 세로는 하단 탭). 선생님 11-10 17시 테마 결정 = B 계열. 모양(색 · 선 · 모서리 · 아이콘 결)은 UI-3 토큰이 서면 거기서 입힌다 — 여기는 지금 토큰으로 구조만.
//
// 규칙
//  · 매일 구역(오늘 · 일감 · 에이전트/팀 · 지식)마다 아이콘 하나 = 그 구역 첫 항목으로 가는 링크. 구역에 항목이 더 있으면(오늘의 결재 · 일감의 목표 · 실행 · 에이전트의 실행 기록 · API 키 · 지식의 산출물 · 스토리지) 아이콘에 올리거나 초점을 주면 옆에 목록이 뜬다.
//  · «대화» 카드(구역 밖 1급)는 «오늘» 바로 뒤. «조직» 아이콘은 막대 아래쪽 — 누르면 조직 항목 전부가 옆으로 펼쳐지고 Esc · 바깥 누름으로 닫힌다.
//  · 맨 아래: 찾기(⌘K) · 설정 · 전체. 건수 배지: «오늘» 아이콘 = 호출부가 넘기는 todayCount(셈은 UI-5), «대화» 아이콘 = 안 읽은 수.
interface NavRailProps {
  orgSlug?: string;
  projectSlug?: string;
  navV3Flags?: NavV3Flags;
  /**
   * «오늘» 아이콘의 건수 — **받아서 그리기만 한다**. 무엇을 세는지(결재 · 답 · 멘션 · 알림의 합 = 오늘 화면 «내 손이 필요해요» 구역 건수)는 담롱군 UI-5(오늘 화면)가 정하고, 호출부가 그 값을 넘긴다
   * (UI-1 §6 ① — 웹 길잡이 · 폰 하단 탭 · 이 막대의 «오늘» 배지가 한 숫자). 이음새는 이 prop 하나뿐이라 셈이 바뀌어도 이 파일은 안 바뀐다.
   */
  todayCount?: number;
  chatUnreadTotal?: number;
  onOpenPalette?: () => void;
}

const DAILY_GROUP_IDS = ['now', 'dev', 'team', 'knowledge'] as const;

export function NavRail({ orgSlug, projectSlug, navV3Flags = DEFAULT_NAV_V3_FLAGS, todayCount = 0, chatUnreadTotal = 0, onOpenPalette }: NavRailProps) {
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
  const orgHasActive = Boolean(orgGroup?.items.some((i) => link(i).isActive));


  const railIcon = (Icon: LucideIcon, active: boolean) => (
    <span className={cn('flex size-10 items-center justify-center rounded-md border border-transparent text-muted-foreground transition', active && 'border-border bg-muted text-foreground')}>
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
  const badge = (n: number) => (n > 0 ? (
    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-micro font-bold text-primary-foreground" data-testid="rail-badge">{n > 99 ? '99+' : n}</span>
  ) : null);

  const dailyEntry = (group: NavGroupConfig) => (
    <DailyEntry key={group.id} group={group} link={link} label={(item) => t(item.labelKey)} icon={railIcon} badge={badge} count={group.id === 'now' ? todayCount : 0} />
  );

  const chatLink = link(CHAT_CENTER_ITEM);
  const dailyGroups = DAILY_GROUP_IDS.map(byId).filter((g): g is NavGroupConfig => Boolean(g));

  return (
    <nav aria-label={t('workspace')} className="sticky top-0 z-20 hidden h-svh w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-2 lg:flex" data-testid="nav-rail">
      {dailyGroups.slice(0, 1).map(dailyEntry)}
      <Link href={chatLink.href} aria-label={t(CHAT_CENTER_ITEM.labelKey)} title={t(CHAT_CENTER_ITEM.labelKey)} aria-current={chatLink.isActive ? 'page' : undefined} className="relative block rounded-md focus-visible:ring-2 focus-visible:ring-ring" data-rail-item={CHAT_CENTER_ITEM.id}>
        {railIcon(MessageSquare, chatLink.isActive)}
        {badge(chatUnreadTotal)}
      </Link>
      {dailyGroups.slice(1).map(dailyEntry)}

      <div className="mt-auto flex flex-col items-center gap-1">
        {orgGroup ? (
          <div ref={orgRef} className="relative" data-rail-group="org">
            <Button type="button" variant="ghost" aria-label={t('zoneOrganization')} title={t('zoneOrganization')} aria-expanded={orgOpen} aria-haspopup="true" onClick={() => setOrgOpen((v) => !v)} className="relative block h-auto min-h-0 min-w-0 rounded-md p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring" data-rail-item="org">
              {railIcon(Building2, orgOpen || orgHasActive)}
            </Button>
            {orgOpen ? (
              <ul role="list" className="absolute bottom-0 left-full z-30 ml-1 flex min-w-52 flex-col gap-0.5 rounded-md border border-border bg-card p-1 shadow-md" data-testid="rail-org-panel">
                {orgGroup.items.map((item) => <FlyoutLink key={item.id} item={item} href={link(item).href} active={link(item).isActive} label={t(item.labelKey)} count={0} onNavigate={() => setOrgOpen(false)} />)}
              </ul>
            ) : null}
          </div>
        ) : null}
        <Button type="button" variant="ghost" aria-label={t('search')} title={`${t('search')} ⌘K`} onClick={onOpenPalette} className="block h-auto min-h-0 min-w-0 rounded-md p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-ring" data-rail-item="search">
          {railIcon(Search, false)}
        </Button>
        {settingsItem ? (
          <Link href={link(settingsItem).href} aria-label={t(settingsItem.labelKey)} title={t(settingsItem.labelKey)} aria-current={link(settingsItem).isActive ? 'page' : undefined} className="block rounded-md focus-visible:ring-2 focus-visible:ring-ring" data-rail-item={settingsItem.id}>
            {railIcon(settingsItem.icon, link(settingsItem).isActive)}
          </Link>
        ) : null}
        <Link href={flatHref(ALL_SCREENS_ITEM.path)} aria-label={t(ALL_SCREENS_ITEM.labelKey)} title={t(ALL_SCREENS_ITEM.labelKey)} aria-current={activeStaticId === ALL_SCREENS_ITEM.id ? 'page' : undefined} className="block rounded-md focus-visible:ring-2 focus-visible:ring-ring" data-rail-item={ALL_SCREENS_ITEM.id}>
          {railIcon(LayoutGrid, activeStaticId === ALL_SCREENS_ITEM.id)}
        </Link>
      </div>
    </nav>
  );
}

// 매일 구역 하나 = 아이콘 링크 하나(구역 첫 항목) + 항목이 더 있으면 옆에 뜨는 목록. 목록은 호버 · 키보드 초점 · (Esc로 닫힘)이 상태로 열고 닫는다 —
// CSS 호버만으로 열면(group-hover) 터치에서는 닿지 않는 조작 요소 부류(hover-reveal 가드)가 되므로, 열림을 상태로 쥐고 `hidden`은 닫힘일 때만 쓴다.
function DailyEntry({ group, link, label, icon, badge, count }: {
  group: NavGroupConfig;
  link: (item: Pick<NavItemConfig, 'id' | 'kind' | 'path'>) => { href: string; isActive: boolean };
  label: (item: NavItemConfig) => string;
  icon: (Icon: LucideIcon, active: boolean) => ReactNode;
  badge: (n: number) => ReactNode;
  count: number;
}) {
  const [open, setOpen] = useState(false);
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
      onFocus={() => setOpen(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
    >
      <Link href={firstLink.href} aria-label={label(first)} title={label(first)} aria-current={anyActive ? 'page' : undefined} className="relative block rounded-md focus-visible:ring-2 focus-visible:ring-ring" data-rail-item={first.id}>
        {icon(first.icon, anyActive)}
        {badge(count)}
      </Link>
      {rest.length > 0 ? (
        <ul role="list" className={cn('absolute left-full top-0 z-30 ml-1 min-w-44 flex-col gap-0.5 rounded-md border border-border bg-card p-1 shadow-md', open ? 'flex' : 'hidden')} data-testid="rail-flyout" data-open={open}>
          {group.items.map((item) => <FlyoutLink key={item.id} item={item} href={link(item).href} active={link(item).isActive} label={label(item)} count={0} />)}
        </ul>
      ) : null}
    </div>
  );
}

function FlyoutLink({ item, href, active, label, count, onNavigate }: { item: NavItemConfig; href: string; active: boolean; label: string; count: number; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <li>
      <Link href={href} onClick={onNavigate} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', active && 'bg-muted font-medium text-foreground')} data-flyout-item={item.id}>
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count > 0 ? <span className="rounded-full bg-primary px-1.5 text-micro font-bold text-primary-foreground">{count > 99 ? '99+' : count}</span> : null}
      </Link>
    </li>
  );
}
