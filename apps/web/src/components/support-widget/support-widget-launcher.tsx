'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LifeBuoy, X } from 'lucide-react';
import { useSidebar } from '@/components/ui/sidebar';
import { useSupportWidgetSession } from '@/hooks/use-support-widget-session';
import { SupportWidgetPanelHeader, SupportWidgetPanelBody } from './support-widget-panel';

const PANEL_ID = 'support-widget-panel';
// story #3260 2차 finding(유나 pre-merge 수치 판정) — 사이드바 폭+런처 사이 시각 여백.
const DESKTOP_SIDEBAR_GAP_PX = 16;

/**
 * story #3260(지원v1 v1·2위젯) — 플로팅 런처+오버레이. 마운트 자리는
 * apps/web/src/app/dashboard/dashboard-shell.tsx의 `<SidebarProvider>` 안(ShellBody와 형제) —
 * `useSidebar()` 컨텍스트를 읽어야 해서(아래 데스크톱 배치 참고) SidebarProvider 밖에 두면
 * "useSidebar must be used within a SidebarProvider" 로 크래시한다. "로그인 후 화면만"은 이
 * 마운트가 (authenticated)/layout.tsx 하위에서만 렌더되는 DashboardShell 안이라는 사실 자체로
 * 성립한다(별도 클라이언트 체크 불요).
 *
 * ⚠️본체 chat 실시간(realtime-provider.tsx `useSseMultiplexerContext()`)을 이 컴포넌트도,
 * use-support-widget-session.ts도 절대 구독하지 않는다 — Support Gateway는 물리적으로 다른
 * 서비스라 같은 EventSource/구독 레지스트리를 타면 안 된다(이중소비·고아 슬롯 결함 클래스,
 * story #2102급 dedup 강제 스캔 대상이기도 함 — 그 훅이 실 SSE를 열게 되면 그때
 * sse-dedup-enforcement 쪽 EXEMPTIONS/가드 적용 여부를 재검토할 것).
 *
 * 위치=좌하단(우하단 아님). 우하단은 이미 toast.tsx(`fixed right-4`, 앱 전역 토스트)·
 * kanban-board.tsx 저장오류 배너(`fixed bottom-4 right-4`)가 선점한 자리라, 상주 런처를
 * 거기 얹으면 토스트가 뜰 때마다 겹친다(플로팅 UI 전뷰포트 충돌체크 원칙).
 *
 * 모바일(<lg=1024, `useSidebar().isMobile` — MOBILE_BREAKPOINT=1024로 Tailwind lg:와 정확히
 * 동일 임계값)에서는 AppSidebar가 Sheet(오프캔버스, 화면 폭을 안 먹음) + MobileTabBar
 * (mobile-tab-bar.tsx, `h-16`=64px, 일반 flow로 화면 최하단 전폭 차지)가 대신 뜬다. 이
 * 컴포넌트는 fixed(뷰포트 기준)라 문서 흐름과 무관하게 겹칠 수 있어, 모바일에서만 bottom
 * 오프셋을 탭바 높이+여백만큼 올린다(bottom-20 = 5rem = 64px+16px). left는 그대로 5(사이드바가
 * 화면 폭을 안 먹으므로 충돌 없음).
 *
 * ⚠️story #3260 2차 finding(2026-08-31, 유나 pre-merge 수치 판정) — 1차 수정(lg:bottom-40)은
 * "덮는 행이 SidebarFooter에서 Storage·Memory nav로 바뀌었을 뿐"이었다: 런처가 여전히
 * `left-5`로 **사이드바 x-범위 안**에 있는 한, 세로 오프셋은 어떤 사이드바 항목을 덮을지만
 * 고를 뿐 근본 해소가 아니다(같은 목업검증이 SidebarFooter만 재현해 사이드바 nav 영역을
 * 놓친 것도 같은 함정). 근본 처방=**가로로 사이드바를 벗어난다**. 사이드바 폭은 200~360px
 * 사용자 리사이즈 가능(ui/sidebar.tsx `width` state, 정적 값 하드코딩은 최대폭 아래에서
 * 다시 겹치는 "폭 가변" 함정) — `useSidebar()`가 그 실시간 폭을 그대로 노출하므로 정적 추정
 * 대신 이 값을 직접 소비한다. `collapsible="offcanvas"`(app-sidebar.tsx)라 collapsed 상태는
 * 사이드바가 화면 밖으로 완전히 밀려나(가시 폭 0) 별도 처리 불요 — left-5 그대로 안전.
 *
 * ⚠️story #3260 3차 finding(2026-08-31, 선생님 실기기 적발→유나 design 확定) — 모바일
 * 채팅-상세 화면(`/chats/{id}`)은 자체 하단 첨부/전송 아이콘 열이 있어, 이 런처(bottom-20
 * left-5)가 그 위에 그대로 겹쳤다(실기기 스크린샷 실증). `/chats`(id 없는 리스트)는 그런
 * 하단 열이 없어 겹치지 않는다 — 그래서 "모바일 전체 숨김"이 아니라 **채팅-상세 라우트에서만**
 * render null 한다(데스크톱은 스플릿뷰라 리스트+상세가 항상 같이 보여 무관, chats/layout.tsx의
 * `isListRoute = pathname === '/chats'` 판정과 대칭 — 상세는 그 나머지 `/chats/*`).
 */
export function SupportWidgetLauncher() {
  const t = useTranslations('supportWidget');
  const [open, setOpen] = useState(false);
  const session = useSupportWidgetSession();
  const { isMobile, state: sidebarState, width: sidebarWidth } = useSidebar();
  const pathname = usePathname();
  const isMobileChatDetailRoute = isMobile && pathname !== '/chats' && pathname.startsWith('/chats/');

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
  // 규칙) — 모바일 채팅-상세에서는 통째로 숨긴다(패널이 열려있었다면 그것도 함께 사라짐,
  // 겹치는 화면 자체를 안 그리는 게 옳다).
  if (isMobileChatDetailRoute) return null;

  // 모바일: 사이드바가 화면 폭을 안 먹어 기본 left-5(className) 그대로 — style override 없음.
  // 데스크톱·사이드바 열림: 실 폭(리사이즈 반영) + 여백만큼 오른쪽으로.
  // 데스크톱·사이드바 닫힘(offcanvas): 가시 폭 0 — left-5 그대로.
  const desktopLeftPx = !isMobile && sidebarState === 'expanded' ? sidebarWidth + DESKTOP_SIDEBAR_GAP_PX : null;
  const positionStyle: CSSProperties | undefined = desktopLeftPx != null ? { left: desktopLeftPx } : undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? t('closeLabel') : t('launcherLabel')}
        style={positionStyle}
        className="fixed bottom-20 left-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 lg:bottom-5"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <LifeBuoy className="h-5 w-5" aria-hidden />}
      </button>
      {open ? (
        <div
          id={PANEL_ID}
          role="dialog"
          aria-label={t('panelTitle')}
          style={positionStyle}
          className="fixed bottom-[8.75rem] left-5 z-40 flex h-[min(480px,calc(100vh-11rem))] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl lg:bottom-20 lg:h-[min(480px,calc(100vh-6rem))]"
        >
          <SupportWidgetPanelHeader onClose={() => setOpen(false)} />
          <SupportWidgetPanelBody session={session} />
        </div>
      ) : null}
    </>
  );
}
