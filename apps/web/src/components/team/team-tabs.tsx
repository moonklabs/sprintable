'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TEAM_TABS } from '@/lib/nav-config';
import { findActiveStaticItemId } from '@/lib/nav-active';
import { useFlatHref } from '@/hooks/use-flat-href';
import { useOrgAdmin } from '@/hooks/use-org-admin';
import { TabNav, TabNavLink } from '@/components/ds/tab-nav';

/**
 * story #4885 (UI-2 AC4 · «팀» 탭줄) — 구성원 · 에이전트 · 실행 기록 · API 키 · 채용을 한 줄로 잇는다. 라우트는 그대로(탭 = 진짜 페이지 이동 링크), 두 화면을 한 목록으로 합치지 않는다.
 * story 4889 (UI-6 · W1~W6) — 에이전트 화면 안쪽의 두 번째 탭줄(통계 · 관리 · 채용 · 접근권한)이 이 줄로 합쳐졌다: **한 줄 · 링크 일곱**(통계 · 접근권한 추가 — 접근권한은 조직 관리자에게만). 순서 = 이미 쓰던 다섯 + 통계 · 접근권한(PO 11-10).
 * 어느 탭이 켜지는지는 사이드바 · 막대와 같은 «지금 여기» 함수(nav-active)가 정한다 — 에이전트 상세(/organization/workforce/{id})도 «에이전트» 아래라 줄이 사라지지 않는다. 탭 이름 없는 주소와 옛 `?tab=manage`는 «에이전트»가 켜진다.
 * 부품: 유나 UI-3 ds `TabNav`(5545 · 이동 링크 탭줄 — `nav` 랜드마크 + 켜진 링크 `aria-current="page"`).
 */
export function TeamTabs() {
  const tn = useTranslations('nav');
  const ta = useTranslations('agents');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const flatHref = useFlatHref();
  const { isAdmin, loaded } = useOrgAdmin();
  const tabs = TEAM_TABS.filter((tab) => !tab.adminOnly || isAdmin);
  // 일반 구성원이 `?tab=access`로 와도(관리자만 쓰는 패널) 화면은 통계로 읽힌다 — 줄도 «통계»를 켠다(에이전트 화면의 같은 판정과 한 소리 · 역할 답이 온 뒤에만).
  const search = loaded && !isAdmin && searchParams.get('tab') === 'access' ? new URLSearchParams({ ...Object.fromEntries(searchParams), tab: 'stats' }) : searchParams;
  const activeId = findActiveStaticItemId(tabs.map((tab) => ({ id: tab.id, kind: 'static' as const, path: tab.path })), pathname, search);
  return (
    <TabNav aria-label={tn('zoneTeam')} data-testid="team-tabs">
      {tabs.map((tab) => (
        <TabNavLink key={tab.id} asChild active={tab.id === activeId}>
          <Link href={flatHref(tab.path)} data-team-tab={tab.id}>
            {tab.ns === 'agents' ? ta(tab.labelKey) : tn(tab.labelKey)}
          </Link>
        </TabNavLink>
      ))}
    </TabNav>
  );
}
