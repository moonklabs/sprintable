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
 * 활성 표시 정본(유나 § 확定, 2026-09-22, doc 6a179c7c) — v3 파랑(`bg-primary/10
 * text-primary font-medium` + `aria-current="page"`). 레거시 사이드바의 회색
 * (`sidebar-accent`)은 이 모듈에 채택하지 않는다(근거: 색+굵기 2축 vs 칠 하나,
 * AA 대비 5.21:1(light)/5.49:1(dark), v3 3화면+모바일 탭바가 이미 파랑 언어).
 * 호버(비활성)는 중립(`hover:bg-muted`)으로 — 파랑 활성과 안 섞이게. 포커스 링은
 * 현행 v3에 없던 신규(`focus-visible:ring-2 focus-visible:ring-ring
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
                ? 'flex items-center gap-2.5 rounded-md bg-primary/10 px-2.5 py-2 text-sm font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                : 'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
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
