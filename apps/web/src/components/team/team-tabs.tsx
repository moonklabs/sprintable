'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TEAM_TABS } from '@/lib/nav-config';
import { findActiveStaticItemId } from '@/lib/nav-active';
import { useFlatHref } from '@/hooks/use-flat-href';
import { cn } from '@/lib/utils';

/**
 * story #4885 (UI-2 AC4 · «팀» 탭줄) — 구성원 · 에이전트 · 실행 기록 · API 키 · 채용을 한 줄로 잇는다. 라우트는 그대로(탭 = 진짜 페이지 이동 링크), 두 화면을 한 목록으로 합치지 않는다.
 * 어느 탭이 켜지는지는 사이드바 · 막대와 같은 «지금 여기» 함수(nav-active)가 정한다 — 에이전트 상세(/organization/workforce/{id})도 «에이전트» 아래라 줄이 사라지지 않는다.
 * 부품: 아직 ds Tabs가 없어(물결 1b) 일감 탭줄(workspace-frame-tabs)과 같은 «바깥 프레임 = 밑줄» 문법을 지금 부품 그대로 쓴다 — Tabs가 서면 갈아 끼운다.
 */
export function TeamTabs() {
  const tn = useTranslations('nav');
  const ta = useTranslations('agents');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const flatHref = useFlatHref();
  const activeId = findActiveStaticItemId(TEAM_TABS.map((tab) => ({ id: tab.id, kind: 'static' as const, path: tab.path })), pathname, searchParams);
  return (
    <div className="border-b border-border" data-testid="team-tabs-rule">
      <nav
        aria-label={tn('zoneTeam')}
        className="focus-inset flex items-center gap-4 overflow-x-auto overflow-y-hidden px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-testid="team-tabs"
      >
        {TEAM_TABS.map((tab) => {
          const active = tab.id === activeId;
          return (
            <Link
              key={tab.id}
              href={flatHref(tab.path)}
              aria-current={active ? 'page' : undefined}
              data-team-tab={tab.id}
              className={cn(
                'shrink-0 whitespace-nowrap font-semibold transition -mb-px border-b-[3px] px-1 pb-2.5 pt-3 text-base lg:border-b-2 lg:pb-2 lg:text-sm',
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.ns === 'agents' ? ta(tab.labelKey) : tn(tab.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
