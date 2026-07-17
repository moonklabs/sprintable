'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CircleDot, Inbox, MessageSquare, Grid2x2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GateItem } from '@/components/kanban/types';
import { MOBILE_BREAKPOINT } from '@/hooks/use-mobile';

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

function isTabActive(pathname: string, href: string): boolean {
  if (href === '/inbox') {
    // "결재함" 탭은 /inbox 루트만 자기 것으로 친다(하위 라우트 없음 — bare path 매치).
    return pathname === '/inbox';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function MobileTabBar() {
  const t = useTranslations('mobileTabBar');
  const pathname = usePathname();
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

  return (
    <nav
      aria-label={t('navLabel')}
      className="flex h-16 shrink-0 border-t border-border bg-card lg:hidden"
    >
      {TABS.map(({ key, href, icon: Icon, labelKey }) => {
        const active = isTabActive(pathname, href);
        const badge = key === 'approvals' && pendingCount > 0 ? pendingCount : null;
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
                  {badge > 9 ? '9+' : badge}
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
