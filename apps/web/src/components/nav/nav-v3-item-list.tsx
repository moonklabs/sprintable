'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Link2, MessageSquare, Newspaper, TrendingUp, Workflow } from 'lucide-react';
import { resolveNavV3Destinations, type NavV3Flags } from '@/lib/nav-v3-destinations';
import { destHref } from '@/components/nav/mobile-tab-bar';

/**
 * story #4004(E-UX-OVERHAUL·셸 통합 3/N·FE) — v3 3화면(오늘·대화·연결·규칙)이 각자
 * 손으로 그리던 nav 항목(목적지 리터럴 + 활성/호버/포커스 스타일)을 이 공유 컴포넌트
 * 하나로 옮긴다. 목적지는 #4003(nav-v3-destinations.ts)의 결정 함수 그대로(복붙 규칙
 * 0), resource kind(「일감」)의 bare href는 mobile-tab-bar.tsx의 destHref를 그대로
 * 재사용(호출부가 org/project 컨텍스트를 안 받는 v3 셸의 기존 관례 — proxy.ts의
 * bare-path 301 안전망이 최종 착지를 보정, mobile-tab-bar.tsx 상단 주석 참고).
 *
 * 활성 표시 정본 — story #4006(critical, 5pt) §6 역전(2026-09-22, doc
 * 5bc82986-6617-4e5a-9f4d-aef29e2201f9) — #4004 PASS 당시 정본이었던 v3 파랑
 * (`bg-primary/10 text-primary`, doc 6a179c7c)을 레거시 사이드바 page-active
 * 묶음(`components/ui/sidebar.tsx:539` data-active)으로 되돌린다: `bg-sidebar-
 * active-fill` + `border-l-proof-citron`(좌측 선) + `font-medium` + `text-
 * sidebar-active-fill-foreground`. 근거 — v3 3화면만 파랑이면 화면마다 활성
 * 표시가 갈리는 것 자체가 이 스토리가 잡는 결함(§6): app 전역이 이미 이 묶음을
 * 쓰므로 v3↔레거시가 한 언어가 되게(blast radius도 최소 — v3 3화면만 바뀌고
 * 레거시는 무변). 좌측 선은 비활성일 때 `border-l-transparent`로 자리만
 * 예약해 둬 활성 전환 때 레이아웃이 안 밀리게 한다(sidebar.tsx 관례 동형).
 * 호버(비활성)는 중립(`hover:bg-muted`)으로 유지 — §6은 활성만 역전. 포커스
 * 링은 현행 v3에 없던 신규(`focus-visible:ring-2 focus-visible:ring-ring
 * focus-visible:ring-offset-2`).
 */
export type NavV3ItemKey = 'today' | 'chats' | 'work' | 'results' | 'connectRules';

interface NavV3ItemDef {
  key: NavV3ItemKey;
  // labelKey는 레거시 사이드바(nav-config.ts)가 이미 쓰는 'nav' 네임스페이스 키
  // 그대로 재사용(새 i18n 키 발명 0) — 「같은 사실=같은 낱말」(story #3824 CHANGES②
  // 원칙과 동형).
  labelKey: string;
  icon: typeof Newspaper;
}

const NAV_V3_ITEMS: readonly NavV3ItemDef[] = [
  { key: 'today', labelKey: 'zoneNow', icon: Newspaper },
  { key: 'chats', labelKey: 'chats', icon: MessageSquare },
  { key: 'work', labelKey: 'zoneDev', icon: Workflow },
  { key: 'results', labelKey: 'navResults', icon: TrendingUp },
  { key: 'connectRules', labelKey: 'zoneConnectRules', icon: Link2 },
];

export interface NavV3ItemListProps {
  flags: NavV3Flags;
  activeKey: NavV3ItemKey;
  /** 「오늘」 항목에만 붙는 배지(내 결정 큐 건수) — 다른 항목엔 배지 축 자체가 없다. */
  todayBadgeCount?: number;
}

export function NavV3ItemList({ flags, activeKey, todayBadgeCount = 0 }: NavV3ItemListProps) {
  const t = useTranslations('nav');
  const dest = resolveNavV3Destinations(flags);

  return (
    <nav className="mt-1 flex flex-col gap-0.5" data-testid="nav-v3-item-list">
      {NAV_V3_ITEMS.map((item) => {
        const destination = dest[item.key];
        // 「연결·규칙」은 flag OFF면 null(항목 자체를 안 낸다 — 옛 진입점 지우지 않는다
        // 원칙, nav-v3-destinations.ts 파일 상단 주석 참고).
        if (!destination) return null;
        const isActive = item.key === activeKey;
        const Icon = item.icon;
        return (
          <Link
            key={item.key}
            href={destHref(destination)}
            data-testid={`nav-v3-item-${item.key}`}
            aria-current={isActive ? 'page' : undefined}
            className={
              isActive
                ? 'flex items-center gap-2.5 rounded-md border-l-2 border-l-proof-citron bg-sidebar-active-fill px-2.5 py-2 text-sm font-medium text-sidebar-active-fill-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                : 'flex items-center gap-2.5 rounded-md border-l-2 border-l-transparent px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            }
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
            {item.key === 'today' && todayBadgeCount > 0 ? (
              <span className="flex h-[19px] min-w-[19px] items-center justify-center rounded-full bg-primary px-1 text-[11.5px] font-bold text-primary-foreground">
                {todayBadgeCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * story #4006(critical, 5pt) AC2 — v3 nav 칸의 폭·접힘은 공유 컴포넌트 한 곳에서만
 * 정한다(세 화면 파일에 `w-[216px]` 류 nav 고정폭 리터럴 0 — grep 0 단언, verify-
 * nav-v3-narrow-width-single-source.test.ts). lg(1024, 레포 useIsMobile 관례와
 * 동일 경계) 이상은 현행 216px aside 그대로, 미만은 `hidden`(§2 시안 — 상단 nav
 * «발명» 0, 대신 기존 레거시 하단 MobileTabBar를 각 v3 화면이 별도로 물린다).
 */
export interface NavV3SidebarProps {
  flags: NavV3Flags;
  activeKey: NavV3ItemKey;
  /** 「오늘」 항목에만 붙는 배지 — NavV3ItemList로 그대로 전달. */
  todayBadgeCount?: number;
}

export function NavV3Sidebar({ flags, activeKey, todayBadgeCount = 0 }: NavV3SidebarProps) {
  return (
    <aside
      className="hidden w-[216px] shrink-0 flex-col border-r border-border bg-card p-3 lg:flex"
      data-testid="nav-v3-sidebar"
    >
      <NavV3ItemList flags={flags} activeKey={activeKey} todayBadgeCount={todayBadgeCount} />
    </aside>
  );
}
