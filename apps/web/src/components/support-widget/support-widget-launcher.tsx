'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LifeBuoy, X } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { useActivationStatus } from '@/hooks/use-activation-status';
import { useSupportWidgetSession } from '@/hooks/use-support-widget-session';
import { SupportWidgetPanelHeader, SupportWidgetPanelBody } from './support-widget-panel';

const PANEL_ID = 'support-widget-panel';

/**
 * story #3274(지원v1·후속, 선생님 확定 2026-09-01 — "좌하단은 말이 안 됨"·"상시 플로팅
 * 자체가 방해") — 상시 노출 폐기. 새 모델: **온보딩 단계(activation 미완주)에서만** 이
 * 플로팅이 뜬다. 완주 후 일반 진입은 설정 > 문의 탭(settings/page.tsx `support` 탭 —
 * 이 컴포넌트가 쓰는 패널/세션 훅을 그대로 인라인 임베드해 재사용, 발명 0)뿐이다. "온보딩
 * 단계"의 실물 판정은 두 벌을 만들지 않고 activation-checklist-banner.tsx와 같은 판별자
 * (`useActivationStatus()`, `!allComplete`)를 공유한다(PO 확定 — checklist all_complete가
 * 이미 있는 5단계 판별의 재사용).
 *
 * 자리는 우하단(좌하단 폐기 — 우하단이 표준 UX). 이전 좌하단 시절 "사이드바 실 폭 회피"
 * 로직(useSidebar 폭 읽기+동적 left 오프셋, story #3260 2차 finding)은 전부 걷었다 — 걷는
 * 이유는 우측으로 옮기면 좌측 고정 사이드바와 애초에 안 겹쳐 그 회피 자체가 무의미해졌기
 * 때문(사이드바가 사라진 게 아니라 이 컴포넌트가 반대편으로 이동해 그 축이 통째로 안 걸리게
 * 됨).
 *
 * story #3756 → #3759 — `bottom-20`(5rem 고정) → `--bottom-dock-inset`(탭 바 회피, safe-area
 * 인지) 위 5rem으로 한 차례 고쳤으나, 그 5rem 자체가 «토스트/배너를 피하기 위한 회피 상수»였다
 * (근거 없이 정한 값 — 토스트가 몇 장 쌓이면 다시 깨진다). 지금은 이 컴포넌트 자체가 더 이상
 * `fixed`로 자기 위치를 계산하지 않는다 — 셸의 BottomDock(components/nav 폴더의 dock 컬럼
 * 소유 컴포넌트)이 소유한 `flex flex-col-reverse` 컬럼의 평범한 자식일 뿐이라, "몇 장이
 * 쌓였든 그 위"가 flexbox 레이아웃만으로 저절로 성립한다(계산 0, 유나 定 2026-09-09 20:55Z).
 *
 * 마운트 자리는 BottomDock을 거쳐 여전히 apps/web/src/app/dashboard/dashboard-shell.tsx의
 * `<SidebarProvider>` 안(ShellBody와 형제) — `useSidebar().isMobile`(모바일 채팅-상세 판정에
 * 여전히 필요)을 읽어야 해서 SidebarProvider 밖에 두면 크래시한다. "로그인 후 화면만"은 이
 * 마운트가 (authenticated)/layout.tsx 하위 DashboardShell 안이라는 사실 자체로 성립.
 *
 * ⚠️본체 chat 실시간(realtime-provider.tsx `useSseMultiplexerContext()`)을 이 컴포넌트도,
 * use-support-widget-session.ts도 절대 구독하지 않는다 — Support Gateway는 물리적으로 다른
 * 서비스라 같은 EventSource/구독 레지스트리를 타면 안 된다(이중소비·고아 슬롯 결함 클래스,
 * story #2102급 dedup 강제 스캔 대상이기도 함).
 *
 * ⚠️story #3260 3차 finding(2026-08-31, 선생님 실기기 적발→유나 design 확定)은 그대로
 * 유효 — 모바일 채팅-상세 화면(`/chats/{id}`)은 자체 하단 첨부/전송 아이콘 열이 있어
 * 겹친다. 위치가 우측으로 바뀌어도 그 화면 하단 열과 겹치는 문제 자체는 사라지지 않으므로
 * `isMobileChatDetailRoute` 판정은 그대로 유지한다(`/chats`는 리스트라 무관, 그 나머지
 * `/chats/*`만 상세).
 */
export function SupportWidgetLauncher() {
  const t = useTranslations('supportWidget');
  const [open, setOpen] = useState(false);
  const session = useSupportWidgetSession();
  const { isMobile } = useSidebar();
  const pathname = usePathname();
  const { state: activationState, allComplete } = useActivationStatus();
  const isMobileChatDetailRoute = isMobile && pathname !== '/chats' && pathname.startsWith('/chats/');
  // story #3274(유나 design 리뷰 🟡, 2026-09-01) — 설정 > 문의 탭(support-tab-panel.tsx)이
  // 마운트 시 자체 세션을 연다. 같은 화면에 이 플로팅까지 열려있으면 세션 훅 인스턴스
  // 2개가 각자 로컬 messages state를 가져 서로 안 보이는 뷰 불일치가 생긴다(서버는 org+
  // user당 세션 1개로 멱등이라 데이터 위험은 없지만, 같은 기능의 진입점이 한 화면에 둘
  // 있는 것 자체도 산만하다). isMobileChatDetailRoute와 동형으로 라우트 게이팅해 원천
  // 차단 — 설정 페이지의 상담 진입점은 문의 탭 하나로 충분(진입점 0 아님).
  const isSettingsRoute = pathname != null && (pathname === '/settings' || pathname.startsWith('/settings/'));

  // ⚠️story #3260 2차 finding(2026-08-31, 유나 라이브 실측 FAIL — 재시도 스톰) — 이 effect가
  // 예전엔 [open, session] deps였다. session은 status가 바뀔 때마다(connect()가 실패해
  // 'error'로 떨어질 때 포함) useSupportWidgetSession()의 useMemo가 새 객체를 반환하므로,
  // session 참조 변경 자체가 이 effect를 재발화시켜 connect()를 다시 불렀다 — CSP가 Gateway
  // fetch를 막는 상황에서는 그 실패가 즉시(네트워크 왕복 없이) 나므로 "실패→재발화→재시도"가
  // 사실상 동기 루프로 돌아 4초에 87회(~22/s)를 쳤다(POST /api/support/session-token 실측).
  // 처방: deps를 `open` 하나로 좁히고, connect의 "최신 함수"는 ref로 우회 참조한다 — 이러면
  // open이 실제로 false→true로 바뀔 때만 1회 호출되고, 내부 상태(status) 변화로는 절대
  // 재발화하지 않는다('error' 이후 재시도는 패널의 명시 "다시 연결하기" 버튼(session.connect()
  // 직접 호출)으로만 — 사용자 행동 1회=시도 1회, 자동 루프 0). 훅 쪽에도 최소시도간격(1초)
  // 백오프를 별도로 걸어둔다(use-support-widget-session.ts) — 이 effect 밖의 다른 호출
  // 경로가 생겨도 스톰이 구조적으로 재발 못 하게 하는 2중 방어.
  const connectRef = useRef(session.connect);
  useEffect(() => {
    connectRef.current = session.connect;
  });
  useEffect(() => {
    if (open) connectRef.current();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 모든 hook 호출 뒤에만 조건부 반환한다(hook 호출 순서는 렌더마다 불변이어야 하는 React
  // 규칙) — 온보딩 완주 후엔 이 컴포넌트 자체가 통째로 사라진다(story #3274 새 모델, AC④).
  // 모바일 채팅-상세에서도 통째로 숨긴다(패널이 열려있었다면 그것도 함께 사라짐 — 겹치는
  // 화면 자체를 안 그리는 게 옳다, story #3260 3차 finding 그대로 유효).
  //
  // ⚠️유나 design 리뷰 실블로커(PR#3668 1차, 2026-09-01) — `!activationState` 가드가
  // 빠져 있어 fetch 실패/로딩 중(allComplete=false, state=null)에 배너는 숨는데 런처만
  // fail-open으로 뜨는 비대칭이 있었다("배너 ⟺ 플로팅" 불변식 위반). banner와 정확히
  // 대칭시킨다 — 로딩/실패 중엔 둘 다 보수적으로 숨는다(PO 확認 정책).
  if (allComplete || !activationState || isMobileChatDetailRoute || isSettingsRoute) return null;

  return (
    <>
      {/* story #3759 — fixed/bottom/right 0: BottomDock의 flex-col-reverse 컬럼이 이미
          우하단에 고정돼 있어, 이 버튼은 그 안의 평범한 flex 자식이다. 컬럼 자체가
          pointer-events-none(빈 공간 클릭 통과)이라 실제 버튼은 pointer-events-auto로
          되돌린다. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? t('closeLabel') : t('launcherLabel')}
        className="pointer-events-auto flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <LifeBuoy className="h-5 w-5" aria-hidden />}
      </button>
      {open ? (
        // story #3759 — 패널도 fixed/bottom 회피 상수 0: 이 컴포넌트가 반환하는 Fragment의
        // 두 번째 자식이라, BottomDock의 flex-col-reverse 컬럼 안에서 버튼(첫 자식) «위»에
        // 자동으로 쌓인다(DOM 순서=버튼 먼저·패널 나중 → col-reverse라 나중 자식이 위).
        //
        // story #3759 CHANGES(유나 定+페드루 判, #4106) — 높이는 h-(고정)가 아니라
        // max-h-(상한)다: 컬럼 자신이 이제 max-h 예산을 갖는데(bottom-dock.tsx), 패널이
        // «고정» 높이를 고집하면 토스트가 그 예산을 나눠 가지려 할 때 패널이 밀려 올라가
        // 뷰포트 위로 넘칠 수 있었다(375×667·토스트 1장에서 top -31, #3756이 세운
        // "패널 top ≥ 0" 회귀).
        //
        // story #3759 CHANGES 2차(유나 定+페드루 判, #4106) — 처음엔 shrink-0(밀려도 절대
        // 안 줄어듦)을 줬는데, 그러면 토스트 스택이 전부 눌려 최신 토스트까지 조각으로
        // 잘렸다(정정 캡처 375×667·패널 열림·토스트 5장 → 스택 27px, 최신도 27px 조각).
        // 우선순위를 다시 매겼다: «토스트 1장(항상 온전) > 패널 > 토스트 2장째부터».
        // shrink-0을 걷고 min-h-0(flex 기본 min-height:auto가 컨텐츠만큼 안 줄어드는
        // 것 해제)을 줘 패널이 이제 «양보하는 쪽»이 된다 — 그 대신 toast.tsx
        // ToastContainer가 min-h-[5.5rem](카드 한 장+gap)로 최소 한 장은 절대 안
        // 줄어드는 바닥을 가져, flexbox가 부족한 공간을 패널 쪽에서만 뺏어간다. max-h는
        // 그대로 유지(패널이 무한정 커지진 않는다) — 패널 top ≥ 0 불변식은 여전히 성립.
        <div
          id={PANEL_ID}
          role="dialog"
          aria-label={t('panelTitle')}
          className="pointer-events-auto flex max-h-[min(480px,calc(100vh-var(--bottom-dock-inset)-6rem))] w-[360px] max-w-[calc(100vw-2.5rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        >
          <SupportWidgetPanelHeader onClose={() => setOpen(false)} />
          <SupportWidgetPanelBody session={session} />
        </div>
      ) : null}
    </>
  );
}
