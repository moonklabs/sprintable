'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDot, Inbox, MessageSquare, Grid2x2, Newspaper, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CornerCountBadge } from '@/components/ui/corner-count-badge';
import { MOBILE_BREAKPOINT } from '@/hooks/use-mobile';
import { fetchDesignatedPendingCount } from '@/lib/designated-pending-count-client';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  DEFAULT_NAV_V3_FLAGS,
  resolveNavV3Destinations,
  scopedResourceHref,
  type NavV3Destination,
  type NavV3Destinations,
  type NavV3Flags,
} from '@/lib/nav-v3-destinations';

// story #4016 — resource kind는 org/project 접두가 필요한 조각이다. static kind는 이미 완성 경로라 그대로 쓴다.
// story #4211 — 예전엔 이 탭 바가 접두 컨텍스트를 안 받아 bare `/flow`만 썼다(세션 의존 리다이렉트를 매 탭 한 홉 ·
// 4557 전 301을 캐시한 기기는 탭을 눌러도 옛 프로젝트로 감). 이제 사이드바와 같은 scopedResourceHref로 현재
// 작업공간·프로젝트 경로를 직접 가리킨다(slug를 모르는 찰나만 bare — 미들웨어 안전망).
// TABS/V3_TABS의 `href` 필드는 slug 없이 구운 값(기존 단위테스트 계약) — 실제 렌더 href는 MobileTabBar가
// resolveTabHref(tab, dest, scope)로 매 렌더 다시 구한다.
export function destHref(destination: NavV3Destination, scope: TabHrefScope = {}): string {
  return destination.kind === 'resource'
    ? scopedResourceHref(destination.path, scope.orgSlug, scope.projectSlug)
    : destination.path;
}

export interface TabHrefScope { orgSlug?: string; projectSlug?: string }

// story #1958(P2-S2, mobile-p2-p1a-story-breakdown SSOT) — 모바일 4탭 셸. <1024(lg 미만)에서만
// 렌더되고 데스크톱 GNB(AppSidebar)를 대체한다(P2-S1의 lg:1024 SSOT와 동일 경계 — route 내
// md·lg 혼재 금지 원칙 그대로 따름). 시안 511bc035 v2 기준.
//
// route 매핑(오르테가군 확定, 2026-07-17): "지금"·"결재함" 탭은 셸-우선 원칙에 따라 최종 콘텐츠
// (지금 홈=S8/#1964, 결재함 통합큐=S4/#1960) 없이 기존 라우트를 그대로 가리킨다 — 후속 스토리가
// 그 자리에서 콘텐츠만 원자적으로 교체한다(빅뱅 전환 금지).
// export: story #2279 회귀가드(href가 조용히 되돌아가지 않게 직접 단위테스트).
// story #2224(선생님 정정 2026-07-30) — "지금" 탭의 href를 `/glance`에서 `/flow`로 갱신했다.
// `/glance` 라우트 자체가 삭제됐고(PR#2698), bare `/glance`는 proxy.ts 안전망을 거쳐 결국
// `/flow`로 착지하지만 — "은퇴한 주소가 진입점에 살아 있다"는 지적(선생님)에 따라 최종
// 목적지를 직접 가리킨다(한 홉 절약 + 이름-목적지 일치, #2224 §④ "사람이 누르는 진입점"
// 표면). `/flow`는 아직 모바일 전용 화면(#2225)이 없어 데스크톱과 같은 레이아웃을 그대로
// 받는다 — 이번 판에서는 "폰에서 깨지지 않게"까지만 손대고, 본격 모바일 재설계는 #2225.
// story #3824 CHANGES②(페드루 PO 確定, 2026-09-13 09:01Z) — "같은 사실=같은 낱말": 「채팅」
// 탭과 데스크톱 사이드바 「대화」는 같은 화면(/chats)을 가리키는데 각자 다른 i18n 키
// (mobileTabBar.chat vs nav.chats)를 써서 문구가 갈라져 있었다 — 값이 아니라 **labelKey
// 자체**를 공유해 한쪽이 바뀌면 다른 쪽도 자동으로 같이 바뀌게 한다(재발 방지). 「결재」는
// 모바일 IA 통합이 후속 카드 스코프라 자기 키(mobileTabBar.approvals) 그대로 둔다.
//
// story #4020(페드루 PO 확定 2026-09-17, 유나 PR 4399 design 관찰) — "now" 탭의 labelKey는
// 원래(3824) `zoneNow`(「오늘」)였으나, 그 판정은 "탭 바 「지금」과 사이드바 「오늘」은 같은
// 화면"이라는 **틀린 전제**에 기댔다 — 실제 목적지 `/flow`는 사이드바에서 「일감」
// (nav-config.ts의 `board` 항목, labelKey `zoneDev`)이고, 사이드바의 진짜 「오늘」은
// `/org-briefing`(다른 항목)이다. 목적지는 선생님 2026-07-30 결정(#2224)이라 유지하고,
// 라벨을 그 목적지의 실제 이름(zoneDev)으로 맞춘다 — prod(main)는 이미 라벨이 「지금」
// (mobileTabBar.now, 목적지와 이름이 어긋나지 않는 옛 낱말)이라 이 수정이 오히려 3824
// 이전 prod와도, 사이드바 실목적지와도 동시에 맞아떨어진다.
// story #4016(페드루 PO 確定 2026-09-17) — href를 더는 손으로 안 박는다. 4386의
// resolveNavV3Destinations가 「일감」(now 탭)·「대화」(chat 탭)의 플래그별 목적지를
// 이미 결정하고 있었는데 여기가 그걸 안 물어서 사이드바만 바뀌고 좁은 폭은 레거시로
// 남았다(이 카드의 근거 버그). 「결재」·「전체」는 애초에 그 모듈에 플래그가 없던
// 항목이라 results와 동형인 고정 키 2개를 새로 추가해 여기 4탭 전부가 한 소스를
// 쓴다(AC1). destKey가 그 모듈의 어느 항목에 매이는지를 표시 — labelKey 공유(위
// #3824)와는 별개 축이다(now 탭 labelKey는 위 #4020 정정대로 zoneDev지만 destKey는
// today가 아니라 work — AC2 "플래그 OFF 바이트 동일"을 만족하는 쪽은 work뿐, 페드루
// 확認 2026-09-17 14:34Z). href 필드는 DEFAULT_NAV_V3_FLAGS(전부 OFF)로 미리 구운
// 값이라 기존 테스트(TABS.find(...).href 직접 대조)가 손 안 대고 그대로 GREEN —
// 플래그 ON의 실제 렌더 href는 MobileTabBar 컴포넌트 안에서 resolveTabHref(tab, dest, scope)로
// 매 렌더 다시 구한다.
const DEFAULT_DEST = resolveNavV3Destinations(DEFAULT_NAV_V3_FLAGS);

export const TABS = [
  { key: 'now', destKey: 'work' as const, href: destHref(DEFAULT_DEST.work), icon: CircleDot, labelKey: 'zoneDev' as const, namespace: 'nav' as const },
  // story #2279(PO 판정, 2026-07-29): 라벨("결재")·배지(게이트 대기 수)와 착지가 어긋나
  // 있던 것 — 이름=가는 곳=세는 것 셋을 한 줄로 맞춘다. #2164가 세운 "진입점 라벨은 착지
  // 탭과 일치" 규칙은 그대로 두고 착지 쪽을 게이트 탭으로 옮긴다(라벨을 규칙에 맞춘다).
  // "알림" 탭은 안 없어진다 — /inbox 페이지 내부 탭 스위처로 한 번 더 탭하면 그대로 있다.
  { key: 'approvals', destKey: 'approvals' as const, href: destHref(DEFAULT_DEST.approvals), icon: Inbox, labelKey: 'approvals' as const, namespace: 'mobileTabBar' as const },
  { key: 'chat', destKey: 'chats' as const, href: destHref(DEFAULT_DEST.chats), icon: MessageSquare, labelKey: 'chats' as const, namespace: 'nav' as const },
  // "전체"는 시안상 정식 목록화 대상(S9/#1965) — 기존 모바일 GNB Sheet(햄버거) 재사용은
  // blueprint §3.2 "모바일 사이드바 폐기" 방향과 충돌해 하지 않는다(오르테가군 확定). 이 스토리
  // 에서는 최소 스텁 라우트로만 연결 — S9가 정식 목록으로 교체.
  { key: 'more', destKey: 'more' as const, href: destHref(DEFAULT_DEST.more), icon: Grid2x2, labelKey: 'more' as const, namespace: 'mobileTabBar' as const },
] as const;

// story #4006(critical, 5pt) AC8(§2, doc 5bc82986) — v3 플래그 중 하나라도 ON이면
// (nav-v3-destinations.ts의 anyV3Enabled와 동일 신호, resolveNavV3Destinations.work
// 참고) 하단 탭이 이 4탭으로 바뀐다: 오늘·대화·일감·더보기. 「승인」은 별 탭 없이
// 「오늘」의 결정 큐로 흡수(PO 確定 — today_service의 `_needs_me_from_gate_inbox`가
// ApprovalsQueue와 같은 `list_gate_inbox(status=pending, sort=urgency,
// assigned_to_me=True)`·limit 없음이라 누락 0 — 그래서 badge도 아래 렌더에서 기존
// pendingCount를 그대로 「오늘」 탭에 옮겨 붙인다, 새 API 0). 「결과·연결·규칙」은 이
// 4탭엔 없고 `/more` 목록에서 진입(AC8, 이 모듈 스코프 밖).
export const V3_TABS = [
  { key: 'today', destKey: 'today' as const, href: destHref(DEFAULT_DEST.today), icon: Newspaper, labelKey: 'zoneNow' as const, namespace: 'nav' as const },
  { key: 'chat', destKey: 'chats' as const, href: destHref(DEFAULT_DEST.chats), icon: MessageSquare, labelKey: 'chats' as const, namespace: 'nav' as const },
  { key: 'work', destKey: 'work' as const, href: destHref(DEFAULT_DEST.work), icon: Workflow, labelKey: 'zoneDev' as const, namespace: 'nav' as const },
  { key: 'more', destKey: 'more' as const, href: destHref(DEFAULT_DEST.more), icon: Grid2x2, labelKey: 'more' as const, namespace: 'mobileTabBar' as const },
] as const;

export type TabConfig = typeof TABS | typeof V3_TABS;
export type TabDef = (typeof TABS)[number] | (typeof V3_TABS)[number];

/** flags 중 v3 하나라도 ON이면 V3_TABS, 전부 OFF면 기존 TABS(AC8 "플래그 OFF 탭 4칸 바이트 무변"). */
export function resolveTabsForFlags(navV3Flags: NavV3Flags): TabConfig {
  const anyV3Enabled = navV3Flags.todayV3Enabled || navV3Flags.chatV3Enabled || navV3Flags.connectRulesV3Enabled;
  return anyV3Enabled ? V3_TABS : TABS;
}

export function resolveTabHref(tab: TabDef, dest: NavV3Destinations, scope: TabHrefScope = {}): string {
  return destHref(dest[tab.destKey], scope);
}

// story #1991(navigate 불안정 1차 근원 B, 유나 UX 감사): 기존 isTabActive는 4탭 href 자체와
// 정확일치/그 직계 하위 경로만 인식해, gate/doc/story 상세(canonical 라우트가 탭 href 트리
// 밖에 있음)나 프로젝트/org 영역(board/goals/loops/organization/... 등, #1965 "전체" 스텁
// 목록 그대로) 전부 활성 탭이 없어 하단바가 회색이 됐다. #1951 매니페스트가 이미 확定해둔
// 상세→parentTab 매핑(useSyntheticParentTabHistory 호출부와 동일 SSOT)을 여기서도 재사용해
// "이 경로는 소속상 어느 탭인가"를 판정하는 단일 함수로 교체한다.
//
// story #2224(선생님 정정 2026-07-30) — `/flow`는 다른 ws/proj-scoped 리소스(board·goals·
// loops 등, 아래 ④ 참고)와 달리 "지금" 탭의 목적지 그 자체다 — `/{ws}/{proj}/flow`(3번째
// 세그먼트)뿐 아니라 TABS의 `now.href` 자체가 «bare» `/flow`라 그 형태도 인식해야 한다
// (선생님 실측 2026-07-30 — 탭을 누른 그 순간의 pathname은 bare, proxy.ts 301이 실 slug로
// 착지시키기 «전»의 찰나에 하이라이트가 꺼졌다). `/glance`(옛 라우트)의 bare 인식과 대칭.
// story #4016 — 'flow'가 더 이상 유일한 값이 아니다(v3 ON이면 dest.work.path='work-list')라
// 판정 대상 조각을 인자로 받는다(하드코딩 제거, AC1 "활성 판정도 같은 목적지 값 기준").
function isResourcePath(pathname: string, resourceFragment: string): boolean {
  if (pathname === `/${resourceFragment}` || pathname.startsWith(`/${resourceFragment}/`)) return true;
  const segments = pathname.split('/').filter(Boolean);
  return segments[2] === resourceFragment;
}

// static kind 목적지의 쿼리 부분을 뗀다 — usePathname()은 쿼리스트링을 안 싣는다.
function staticPathOnly(staticPath: string): string {
  return staticPath.split('?')[0]!;
}

// dest.chats.path(예 '/chats')처럼 정확일치+하위 경로(/chats/{id})까지 인식해야 하는 값.
function isStaticPathOrChild(pathname: string, staticPath: string): boolean {
  const pathOnly = staticPathOnly(staticPath);
  return pathname === pathOnly || pathname.startsWith(`${pathOnly}/`);
}

// story #4016 CHANGES(페드루 PO 지적, 2026-09-17 14:46Z) — dest.approvals.path(예
// '/inbox?tab=gates')는 옛 코드부터 «정확일치만»이었다(/inbox/x는 "결재"가 아니라
// "전체" — 알림 상세 등 /inbox 하위 라우트가 생기면 그건 더보기 소관). 위
// isStaticPathOrChild처럼 하위 경로까지 인식하면 실질 영향은 지금 0(하위 라우트가
// 아직 없음)이지만 AC2 "플래그 OFF 바이트 동일" 계약과 어긋나 정확일치로 좁힌다.
function isStaticPathExact(pathname: string, staticPath: string): boolean {
  return pathname === staticPathOnly(staticPath);
}

// 판정 순서(구체적인 것부터, 마지막이 fallback):
//  ① `/{ws}/{proj}/{dest.work.path}`(+하위) 또는 `/glance`(+하위, 옛 라우트 — 리다이렉트
//     경유로 도착할 수 있어 계속 인식) — "지금" 탭 자기 자신.
//  ② dest.approvals.path(쿼리 뗀 경로, 정확일치) 또는 /gates/* — "결재함". gate 상세는
//     #1951에서 parentTab=/inbox로 이미 확定(gates/[id]/page.tsx의
//     useSyntheticParentTabHistory('/inbox') 그대로).
//  ③ dest.chats.path(+하위) — "채팅".
//  ④ 그 외 전부 — "전체"(more). doc 상세(parentTab=/more)·story 상세(parentTab=/more)·
//     board/goals/loops/sprints/standup/retro/organization/settings/... 는 애초에 4탭
//     밖의 프로젝트/org 영역이라 more 페이지 자체가 이들의 진입점(ITEMS 목록, #1958 확定)
//     — "전체"가 이 전부의 소속 탭이라는 게 이미 그 스텁 페이지 설계로 확定돼 있다.
// navV3Flags 생략 시 DEFAULT_NAV_V3_FLAGS(전부 OFF)로 판정 — 기존 1-인자 호출부(테스트
// 포함)와 바이트 동일 동작(AC2).
// story #4006 AC8 — v3(anyV3Enabled) 판정 分岐 추가: 「오늘」이 자기 목적지(dest.today.path)
// 뿐 아니라 옛 「결재」 경로(gates/*·inbox?tab=gates)까지 흡수한다(승인 탭 폐지, §2).
// 「일감」은 이제 key가 'now'가 아니라 'work'(V3_TABS와 정합). 플래그 전부 OFF면 기존
// 판정 그대로(AC8 "플래그 OFF 바이트 무변").
export function getActiveTabKey(
  pathname: string,
  navV3Flags: NavV3Flags = DEFAULT_NAV_V3_FLAGS,
): TabDef['key'] {
  const dest = resolveNavV3Destinations(navV3Flags);
  const anyV3Enabled = navV3Flags.todayV3Enabled || navV3Flags.chatV3Enabled || navV3Flags.connectRulesV3Enabled;
  if (anyV3Enabled) {
    if (isStaticPathOrChild(pathname, dest.today.path)) return 'today';
    if (isStaticPathExact(pathname, dest.approvals.path) || pathname.startsWith('/gates/')) return 'today';
    if (isStaticPathOrChild(pathname, dest.chats.path)) return 'chat';
    if (isResourcePath(pathname, dest.work.path)) return 'work';
    return 'more';
  }
  if (isResourcePath(pathname, dest.work.path) || pathname === '/glance' || pathname.startsWith('/glance/')) return 'now';
  if (isStaticPathExact(pathname, dest.approvals.path) || pathname.startsWith('/gates/')) return 'approvals';
  if (isStaticPathOrChild(pathname, dest.chats.path)) return 'chat';
  return 'more';
}

export function MobileTabBar({
  chatUnreadTotal,
  navV3Flags = DEFAULT_NAV_V3_FLAGS,
}: {
  chatUnreadTotal: number;
  navV3Flags?: NavV3Flags;
}) {
  const t = useTranslations('mobileTabBar');
  // story #4016 — app-sidebar.tsx(4386)와 동일하게 플래그별 목적지를 이 모듈에서 재계산
  // (복붙 규칙 0, AC2).
  const dest = useMemo(() => resolveNavV3Destinations(navV3Flags), [navV3Flags]);
  // story #4211 — 사이드바(app-sidebar resourceLink)와 같은 소스(대시보드 컨텍스트의 현재 org slug·project slug)로
  // resource 탭을 /{ws}/{proj}/{resource} 직접 경로로. 컨텍스트 밖이거나 slug를 모르면 bare(안전망).
  const { orgId, orgMemberships, currentProjectSlug, projectPathUnresolved } = useDashboardContext();
  const scope = useMemo<TabHrefScope>(() => ({
    orgSlug: orgMemberships.find((o) => o.orgId === orgId)?.orgSlug,
    projectSlug: currentProjectSlug,
  }), [orgMemberships, orgId, currentProjectSlug]);
  // story #3824 CHANGES②(페드루 PO 確定) — "now"·"chat" 탭은 nav 네임스페이스의 zoneNow·
  // chats 키를 그대로 공유(같은 labelKey — 위 TABS 주석 참고).
  const tNav = useTranslations('nav');
  const pathname = usePathname();
  // story #1977(트랙B): GNB ③ 채팅 unread 총합(유나 시안 768e89b5 v2) — 데스크톱 사이드바
  // 채팅 항목(app-sidebar.tsx)과 동일 소스. story #2007(perf·서버부하): 여기서 직접
  // useChatUnreadTotal()을 호출하면 AppSidebar와 각자 SSE(EventSource) 연결을 열어 동일
  // 유저 event-stream 연결이 중복된다 — dashboard-shell.tsx가 단일 호출한 값을 prop으로 받는다.
  // 결재함 배지 = 서명 대기 수(유나 §3.1 정합) — GateInbox가 이미 쓰는 것과 동일한
  // `/api/gates?status=pending` 재사용(신규 집계 안 만듦). gate_overridden은 override 시
  // approver row status가 "overridden"으로 전이돼(gate_service.py) pending 조회에서 자동 제외
  // — 별도 필터 불요(백엔드 확認 완료).
  //
  // ⚠️fix(story #1974, 선생님 실사용 지적, prod 승격 예정): 이 fetch가 caller 스코프 필터 없이
  // org 전체 pending을 반환해 "남의 게이트도 내 배지로 세는" 구조적 오배지였다(코드로 확定).
  // `assigned_to_me=true`(디디 BE 계약, #1974)로 "내가 승인 가능한 것만" 스코프. BE 배포 전엔
  // FastAPI가 미인식 쿼리파라미터를 무시하므로 안전한 no-op(기존과 동일 org-wide 동작) — 배포되면
  // 자동으로 개인화 적용.
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    // 유나 가디언 지적(#2249 병합 처리) — 탭바 자체는 `lg:hidden`(CSS 시각 게이팅)이지만
    // CSS hidden은 DOM 마운트/effect 실행을 막지 않는다. 배지 fetch는 <1024에서만 필요하니
    // 데스크톱에서도 매번 나가던 것을 막는다. useIsMobile()의 mount-시 undefined→effect
    // 확定 타이밍 레이스(유나 지적)를 피하려 여기서도 use-synthetic-parent-tab-history.ts와
    // 동일하게 window.innerWidth를 effect 내부에서 동기 판정한다(첫 렌더 즉시 정확한 값).
    if (typeof window === 'undefined' || window.innerWidth >= MOBILE_BREAKPOINT) return;

    let cancelled = false;
    // ⚠️fix(story #1974, 선생님 실사용 지적): 마운트 1회 fetch뿐이라 게이트를 다른 탭/기기에서
    // 처리해도 배지가 안 줄어드는 stale 문제 — DB 실측(2026-07-17)으로 확認(dev pending=0인데
    // 사용자 배지는 그대로 남아있었음). window focus 복귀 시 재조회해 완화(전형적인 "다른 곳에서
    // 처리하고 이 탭으로 돌아옴" 시나리오를 커버 — 실시간 push는 아니지만 이 스토리 스코프에선
    // 충분, 완전한 실시간 갱신은 #1960 결재함 큐 스코프).
    async function loadPendingCount() {
      try {
        // story #3084(2026-08-25 층1, PO 확定) — assigned_to_me(넓은 project-access 질문)를
        // designated-pending-count(순수 "내가 지정 결재자인 미해소 건", room 추론 0)로 교체
        // — app-sidebar.tsx와 동일 SSOT 전환(그 파일 주석 참고).
        // story #4171 — 사이드바와 진행 중 요청 공유(모바일 첫 화면 중복 1건 제거).
        const count = await fetchDesignatedPendingCount();
        if (count !== null && !cancelled) setPendingCount(count);
      } catch {
        // 배지 카운트 실패는 치명적이지 않음 — 숫자 없이 탭만 정상 동작.
      }
    }

    void loadPendingCount();
    window.addEventListener('focus', loadPendingCount);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', loadPendingCount);
    };
  }, []);

  // story #4217 — 못 푼 프로젝트 경로(오류 상태)에선 어느 탭도 활성 아님(링크는 bare라 그 경로를 가리키지 않는다).
  const activeKey = projectPathUnresolved ? null : getActiveTabKey(pathname, navV3Flags);
  // story #4006 AC8 — v3(anyV3Enabled)면 4탭이 V3_TABS로 바뀐다(플래그 OFF는 기존 TABS
  // 그대로, 바이트 무변).
  const tabs = resolveTabsForFlags(navV3Flags);

  return (
    <nav
      aria-label={t('navLabel')}
      // story #3756 — 탭 바 높이는 이제 globals.css `.dashboard-shell-root`가 소유한
      // `--mobile-tab-bar-h`(4rem, 기존 h-16과 동일값) 토큰을 참조한다(두 벌 상수 금지 —
      // 이 값을 바꾸려면 globals.css 그 한 줄만 고치면 우하단 fixed 요소들의 인셋도 함께 맞다).
      className="flex h-[var(--mobile-tab-bar-h)] shrink-0 border-t border-border bg-card lg:hidden"
    >
      {tabs.map((tab) => {
        const { key, icon: Icon, labelKey, namespace } = tab;
        const href = resolveTabHref(tab, dest, scope);
        const active = key === activeKey;
        // story #1977: "채팅" 탭 배지 = GNB unread 총합(결재함 배지와 동일 brand, 구분은
        // 색이 아니라 아이콘+탭 순서 — 유나 시안 768e89b5 v2 디자인 노트).
        // story #4006 AC8 — v3 4탭엔 「승인」이 없다. 같은 pendingCount를 「오늘」 탭
        // 배지로 그대로 옮겨 붙인다(승인 큐가 「오늘」의 결정 큐로 흡수됐다는 뜻 —
        // PO 確定, 위 V3_TABS 주석 참고. 새 fetch 0).
        const badge = (key === 'approvals' || key === 'today') && pendingCount > 0
          ? pendingCount
          : key === 'chat' && chatUnreadTotal > 0
            ? chatUnreadTotal
            : null;
        // story #3518(유나 사전 스티어, 2026-09-05) — CornerCountBadge는 aria-hidden이라
        // 그 수를 보조기술에 전하는 책임은 이 링크에 있다(계약은 corner-count-badge.tsx
        // 주석 참고). ⚠️여기 aria-label을 쓰지 않는다 — 이 탭은 벨/프레즌스와 달리
        // 보이는 텍스트 라벨("채팅"·"결재")이 이미 있어서, aria-label로 접근성 이름을
        // 통째로 갈아치우면 그 보이는 라벨이 이름에서 사라진다(WCAG 2.5.3 Label in
        // Name 위반 — 음성 입력 사용자가 화면에 보이는 말("채팅")로 이 링크를 못
        // 부른다). 대신 시각 라벨 뒤에 sr-only 텍스트를 덧붙인다 — 보이는 라벨은
        // 그대로 두고 수만 "더한다". 상한(9+/99+)도 이름에 반영한다(캡 값이 아니라
        // "그 이상"이라는 사실을 문장으로 — 시각 배지의 캡과 같은 뜻).
        const srCountText = badge === null
          ? null
          : key === 'chat'
            ? (badge > 99 ? t('chatUnreadSrCapped') : t('chatUnreadSr', { count: badge }))
            : (badge > 9 ? t('approvalsPendingSrCapped') : t('approvalsPendingSr', { count: badge }));
        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]',
              active ? 'font-semibold text-primary' : 'text-muted-foreground',
            )}
          >
            <span className="relative">
              <Icon className="size-[22px]" strokeWidth={1.8} />
              {badge !== null ? (
                // story #3431 — 공용 CornerCountBadge로 통합(bell·presence와 동일 정의,
                // 색/크기 무변경). 위치만 이 소비처 고유(아이콘 오른쪽 옆, 코너 아님).
                <CornerCountBadge
                  variant="primary"
                  className="absolute -top-1 left-full ml-0.5"
                  // story #1977: 채팅 unread 총합은 99+ 상한(시안 768e89b5 v2) — 결재함은 기존 9+ 유지
                  value={key === 'chat' ? (badge > 99 ? '99+' : badge) : badge > 9 ? '9+' : badge}
                />
              ) : null}
            </span>
            {namespace === 'nav' ? tNav(labelKey) : t(labelKey)}
            {/* story #3518 — 보이는 라벨 뒤에 이어 붙인다(라벨을 갈아치우지 않는다,
                WCAG 2.5.3). aria-live는 안 붙인다(탭 전환 때마다 안내를 반복하지
                않는다 — 이 링크에 포커스/진입할 때만 한 번 읽힌다). */}
            {srCountText ? <span className="sr-only"> {srCountText}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
