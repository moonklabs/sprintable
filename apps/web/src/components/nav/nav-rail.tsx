'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { DEPTH1_ITEMS, depth1ForPath } from '@/lib/nav-depth1';
import { isRealShortcut } from '@/lib/keyboard-shortcuts';
import type { NavV3Flags } from '@/lib/nav-v3-destinations';
import { useFlatHref } from '@/hooks/use-flat-href';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/ds/icon';
import { CountBadge } from '@/components/ds/count-badge';
import { RAIL_ICON_BY_ITEM_ID } from './rail-icons';
import { RailAccount } from './rail-account';
import type { OrgSwitcherItem } from './unified-switcher';
import type { DashboardProjectOption } from '@/app/dashboard/dashboard-shell';

// story 5031 (C1 step 2a) — the icon bar of the new shell: exactly the four places 홈 · 채팅 · 에이전트 · 설정 (nav-depth1 / nav-placement.json), nothing else on top; at the bottom the list-column toggle · account · search.
// Where everything else went: the list column (app-sidebar.tsx) draws the rows of the place you are in, ⌘K reaches every screen, cards and panels open the rest — nav-placement.json is the table, nav-placement.test.ts keeps it «빠짐 0».
// The keys ⌘1–⌘4 are named in the titles only through isRealShortcut (step 3: hooks/use-depth1-shortcuts.ts is the handler).
// This file only draws: what the four are and which one is lit come from lib/nav-depth1 (the same four the desktop window and the phone tab bar read). Colours · corners · type scale are ds tokens only; sizes are the scale classes (size-10 = 40, size-5 = 20).
export interface NavRailProps {
  /** kept for the shell's call site; the bar no longer builds resource links (the list column does) */
  orgSlug?: string;
  projectSlug?: string;
  /** «계정» 팝오버(길잡이 머리 · 바닥의 쪽이 아닌 입구)에 넘기는 값 — 길잡이와 같은 출처. 안 넘기면 «계정» 아이콘은 그리지 않는다(시험 · 단독 사용). */
  account?: { orgId?: string; orgMemberships: OrgSwitcherItem[]; projectId?: string; projectMemberships: DashboardProjectOption[]; userName?: string };
  navV3Flags?: NavV3Flags;
  /** «홈» 아이콘의 건수 — 받아서 그리기만 한다(셈은 홈 모델 · home-nav-rail.tsx). */
  todayCount?: number;
  /** the «홈» number is a minimum (part of what feeds it could not be read): the badge is drawn «N+» */
  todayCountAtLeast?: boolean;
  chatUnreadTotal?: number;
  onOpenPalette?: () => void;
  /** 목록 칸(왼쪽 길잡이) 접기·펴기 — 막대가 자기 단추를 갖는다(목록 칸 가장자리 손잡이는 막대 뒤에 가려진다). 안 넘기면 단추 없음. */
  listColumn?: { open: boolean; onToggle: () => void };
}

// 막대 단추 공통 모양(모서리 control · 호버 surface-high · 초점 링 action). 링크는 RAIL_LINK, 눌러서 여는 단추는 디자인 Button 위에 RAIL_BUTTON.
const RAIL_LINK = 'relative block rounded-ds-control hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action';
const RAIL_BUTTON = 'relative block h-auto min-h-0 min-w-0 rounded-ds-control p-0 hover:bg-ds-surface-high focus-visible:ring-2 focus-visible:ring-ds-action';
// 건수 배지 자리: 오른쪽 위에 얹되 아이콘 상자를 가리지 않게(배지 아래 끝 = 아이콘 위 끝). 낮은 창(아이콘 칸 32px)에선 더 위로.
const BADGE_PLACE = 'absolute -right-0.5 -top-1.5 [@media(max-height:520px)]:-top-2.5';

export function NavRail({ account, listColumn, todayCount = 0, todayCountAtLeast = false, chatUnreadTotal = 0, onOpenPalette }: NavRailProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const flatHref = useFlatHref();
  const active = depth1ForPath(pathname);

  // 아이콘 한 칸(40px · 낮은 창 높이 520px 이하에선 32px). 켜짐 = action-soft 바탕 + action-text 글, 꺼짐 = ink-3.
  const railIcon = (iconKey: string, lit: boolean) => (
    <span className={cn('flex size-10 items-center justify-center rounded-ds-control transition-colors [@media(max-height:520px)]:size-8', lit ? 'bg-ds-action-soft text-ds-action-text' : 'text-ds-ink-3')}>
      <Icon name={RAIL_ICON_BY_ITEM_ID[iconKey]!} size={20} className="size-5" />
    </span>
  );
  // 링크의 aria-label이 이름을 덮으므로 건수 > 0이면 이름에 «이름 · 건수 뜻 N»을 싣는다(배지 안 sr-only 글만으로는 스크린리더가 못 읽는다).
  const ariaName = (base: string, n: number, tone: 'unread' | 'needs-hand') => (n > 0 ? `${base} · ${t(tone === 'needs-hand' ? 'railNeedsHand' : 'railUnread')} ${n}${tone === 'needs-hand' && todayCountAtLeast ? '+' : ''}` : base);
  const badge = (n: number, tone: 'unread' | 'needs-hand') => (n > 0 ? (
    tone === 'needs-hand'
      ? <CountBadge kind="needs-hand" label={t('railNeedsHand')} count={n} atLeast={todayCountAtLeast} className={BADGE_PLACE} data-testid="rail-badge" />
      : <CountBadge kind="unread" label={t('railUnread')} count={n} className={BADGE_PLACE} data-testid="rail-badge" />
  ) : null);

  return (
    <nav aria-label={t('workspace')} data-testid="nav-rail" className="sticky top-0 z-20 hidden h-svh w-14 shrink-0 flex-col items-center gap-2 border-r border-ds-line bg-ds-surface py-2 [@media(max-height:520px)]:gap-0.5 [@media(max-height:520px)]:pt-3 lg:flex">
      {DEPTH1_ITEMS.map((item) => {
        const lit = active === item.id;
        const count = item.badge === 'needs-hand' ? todayCount : item.badge === 'unread' ? chatUnreadTotal : 0;
        const tone = item.badge === 'needs-hand' ? 'needs-hand' : 'unread';
        const name = t(item.labelKey);
        return (
          <Link
            key={item.id}
            href={flatHref(item.path)}
            aria-label={item.badge ? ariaName(name, count, tone) : name}
            title={isRealShortcut(['⌘', item.shortcut]) ? `${name} ⌘${item.shortcut}` : name}
            aria-current={lit ? 'page' : undefined}
            className={RAIL_LINK}
            data-rail-item={`depth1-${item.id}`}
          >
            {railIcon(`depth1-${item.id}`, lit)}
            {item.badge ? badge(count, tone) : null}
          </Link>
        );
      })}

      <div className="mt-auto flex flex-col items-center gap-2 [@media(max-height:520px)]:gap-0.5">
        {listColumn ? (
          <Button type="button" variant="ghost" aria-label={t('toggleSidebar')} title={t('toggleSidebar')} aria-expanded={listColumn.open} onClick={listColumn.onToggle} className={RAIL_BUTTON} data-rail-item="list-column-toggle">
            {railIcon('list-column-toggle', false)}
          </Button>
        ) : null}
        {account ? <RailAccount {...account} /> : null}
        <Button type="button" variant="ghost" aria-label={t('search')} title={`${t('search')} ⌘K`} onClick={onOpenPalette} className={RAIL_BUTTON} data-rail-item="search">
          {railIcon('search', false)}
        </Button>
      </div>
    </nav>
  );
}
