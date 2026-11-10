'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TEAM_TABS } from '@/lib/nav-config';
import { findActiveStaticItemId } from '@/lib/nav-active';
import { useFlatHref } from '@/hooks/use-flat-href';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';

/**
 * story #4885 (UI-2 AC4 · «팀» 탭줄) — 구성원 · 에이전트 · 실행 기록 · API 키 · 채용을 한 줄로 잇는다. 라우트는 그대로(탭 = 진짜 페이지 이동 링크), 두 화면을 한 목록으로 합치지 않는다.
 * 어느 탭이 켜지는지는 사이드바 · 막대와 같은 «지금 여기» 함수(nav-active)가 정한다 — 에이전트 상세(/organization/workforce/{id})도 «에이전트» 아래라 줄이 사라지지 않는다.
 * 부품: 유나 UI-3 ds `TabNav`(5545 · 이동 링크 탭줄 — `nav` 랜드마크 + 켜진 링크 `aria-current="page"`)로 짓는다 — 예전 손코딩 줄(`focus-inset flex … border-primary`)은 걷었다. 켜짐 · 탭 이름 · 순서 · 링크는 그대로.
 */
export function TeamTabs() {
  const tn = useTranslations('nav');
  const ta = useTranslations('agents');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const flatHref = useFlatHref();
  const activeId = findActiveStaticItemId(TEAM_TABS.map((tab) => ({ id: tab.id, kind: 'static' as const, path: tab.path })), pathname, searchParams);
  return (
    <TabNav aria-label={tn('zoneTeam')} data-testid="team-tabs">
      {TEAM_TABS.map((tab) => (
        <TabNavLink key={tab.id} asChild active={tab.id === activeId}>
          <Link href={flatHref(tab.path)} data-team-tab={tab.id}>
            {tab.ns === 'agents' ? ta(tab.labelKey) : tn(tab.labelKey)}
          </Link>
        </TabNavLink>
      ))}
    </TabNav>
  );
}
