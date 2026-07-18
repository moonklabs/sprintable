'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDot, Inbox, MessageSquare, Grid2x2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GateItem } from '@/components/kanban/types';
import { MOBILE_BREAKPOINT } from '@/hooks/use-mobile';
import { useChatUnreadTotal } from '@/hooks/use-chat-unread-total';

// story #1958(P2-S2, mobile-p2-p1a-story-breakdown SSOT) — 모바일 4탭 셸. <1024(lg 미만)에서만
// 렌더되고 데스크톱 GNB(AppSidebar)를 대체한다(P2-S1의 lg:1024 SSOT와 동일 경계 — route 내
// md·lg 혼재 금지 원칙 그대로 따름). 시안 511bc035 v2 기준.
//
// route 매핑(오르테가군 확定, 2026-07-17): "지금"·"결재함" 탭은 셸-우선 원칙에 따라 최종 콘텐츠
// (지금 홈=S8/#1964, 결재함 통합큐=S4/#1960) 없이 기존 라우트를 그대로 가리킨다 — 후속 스토리가
// 그 자리에서 콘텐츠만 원자적으로 교체한다(빅뱅 전환 금지).
const TABS = [
  { key: 'now', href: '/glance', icon: CircleDot, labelKey: 'now' as const },
  { key: 'approvals', href: '/inbox', icon: Inbox, labelKey: 'approvals' as const },
  { key: 'chat', href: '/chats', icon: MessageSquare, labelKey: 'chat' as const },
  // "전체"는 시안상 정식 목록화 대상(S9/#1965) — 기존 모바일 GNB Sheet(햄버거) 재사용은
  // blueprint §3.2 "모바일 사이드바 폐기" 방향과 충돌해 하지 않는다(오르테가군 확定). 이 스토리
  // 에서는 최소 스텁 라우트로만 연결 — S9가 정식 목록으로 교체.
  { key: 'more', href: '/more', icon: Grid2x2, labelKey: 'more' as const },
] as const;

// story #1991(navigate 불안정 1차 근원 B, 유나 UX 감사): 기존 isTabActive는 4탭 href 자체와
// 정확일치/그 직계 하위 경로만 인식해, gate/doc/story 상세(canonical 라우트가 탭 href 트리
// 밖에 있음)나 프로젝트/org 영역(board/goals/loops/organization/... 등, #1965 "전체" 스텁
// 목록 그대로) 전부 활성 탭이 없어 하단바가 회색이 됐다. #1951 매니페스트가 이미 확定해둔
// 상세→parentTab 매핑(useSyntheticParentTabHistory 호출부와 동일 SSOT)을 여기서도 재사용해
// "이 경로는 소속상 어느 탭인가"를 판정하는 단일 함수로 교체한다.
//
// 판정 순서(구체적인 것부터, 마지막이 fallback):
//  ① /glance — "지금" 탭 자기 자신(+하위 경로 있으면 포함).
//  ② /inbox(정확일치) 또는 /gates/* — "결재함". gate 상세는 #1951에서 parentTab=/inbox로
//     이미 확定(gates/[id]/page.tsx의 useSyntheticParentTabHistory('/inbox') 그대로).
//  ③ /chats(+하위) — "채팅".
//  ④ 그 외 전부 — "전체"(more). doc 상세(parentTab=/more)·story 상세(parentTab=/more)·
//     board/goals/loops/sprints/standup/retro/organization/settings/... 는 애초에 4탭
//     밖의 프로젝트/org 영역이라 more 페이지 자체가 이들의 진입점(ITEMS 목록, #1958 확定)
//     — "전체"가 이 전부의 소속 탭이라는 게 이미 그 스텁 페이지 설계로 확定돼 있다.
export function getActiveTabKey(pathname: string): (typeof TABS)[number]['key'] {
  if (pathname === '/glance' || pathname.startsWith('/glance/')) return 'now';
  if (pathname === '/inbox' || pathname.startsWith('/gates/')) return 'approvals';
  if (pathname === '/chats' || pathname.startsWith('/chats/')) return 'chat';
  return 'more';
}

export function MobileTabBar({ currentTeamMemberId }: { currentTeamMemberId?: string }) {
  const t = useTranslations('mobileTabBar');
  const pathname = usePathname();
  // story #1977(트랙B): GNB ③ 채팅 unread 총합(유나 시안 768e89b5 v2) — 데스크톱 사이드바
  // 채팅 항목(app-sidebar.tsx)과 동일 훅·동일 소스. AppSidebar와 같은 이유로 currentTeamMemberId를
  // dashboard-shell.tsx(ScrollShell)에서 prop으로 받는다 — useDashboardContext() 직접 import는
  // MobileTabBar를 dashboard-shell.tsx가 직접 렌더하므로 순환 참조가 된다(AppSidebar와 동일 회피).
  const chatUnreadTotal = useChatUnreadTotal(currentTeamMemberId);
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
        const res = await fetch('/api/gates?status=pending&assigned_to_me=true');
        if (!res.ok) return;
        const gates = (await res.json()) as GateItem[];
        if (!cancelled) setPendingCount(Array.isArray(gates) ? gates.length : 0);
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

  const activeKey = getActiveTabKey(pathname);

  return (
    <nav
      aria-label={t('navLabel')}
      className="flex h-16 shrink-0 border-t border-border bg-card lg:hidden"
    >
      {TABS.map(({ key, href, icon: Icon, labelKey }) => {
        const active = key === activeKey;
        // story #1977: "채팅" 탭 배지 = GNB unread 총합(결재함 배지와 동일 brand, 구분은
        // 색이 아니라 아이콘+탭 순서 — 유나 시안 768e89b5 v2 디자인 노트).
        const badge = key === 'approvals' && pendingCount > 0
          ? pendingCount
          : key === 'chat' && chatUnreadTotal > 0
            ? chatUnreadTotal
            : null;
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
                <span
                  aria-hidden
                  className="absolute -top-1 left-full ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground"
                >
                  {/* story #1977: 채팅 unread 총합은 99+ 상한(시안 768e89b5 v2) — 결재함은 기존 9+ 유지 */}
                  {key === 'chat' ? (badge > 99 ? '99+' : badge) : badge > 9 ? '9+' : badge}
                </span>
              ) : null}
            </span>
            {t(labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
