'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LifeBuoy, X } from 'lucide-react';
import { useSupportWidgetSession } from '@/hooks/use-support-widget-session';
import { SupportWidgetPanelHeader, SupportWidgetPanelBody } from './support-widget-panel';

const PANEL_ID = 'support-widget-panel';

/**
 * story #3260(지원v1 v1·2위젯) — 플로팅 런처+오버레이. 마운트 자리는
 * apps/web/src/app/dashboard/dashboard-shell.tsx의 `<SessionExpiredDialog />`와 형제(같은
 * DashboardCtx.Provider 안·인증 화면 전체를 감싸는 유일한 지점) — "로그인 후 화면만"이
 * 이 마운트 위치 자체로 성립한다((authenticated)/layout.tsx가 세션 없으면 redirect라 이
 * 컴포넌트 자체가 비로그인 화면에 도달하지 않음, 별도 클라이언트 체크 불요).
 *
 * ⚠️본체 chat 실시간(realtime-provider.tsx `useSseMultiplexerContext()`)을 이 컴포넌트도,
 * use-support-widget-session.ts도 절대 구독하지 않는다 — Support Gateway는 물리적으로 다른
 * 서비스라 같은 EventSource/구독 레지스트리를 타면 안 된다(이중소비·고아 슬롯 결함 클래스,
 * story #2102급 dedup 강제 스캔 대상이기도 함 — 그 훅이 실 SSE를 열게 되면 그때
 * sse-dedup-enforcement 쪽 EXEMPTIONS/가드 적용 여부를 재검토할 것).
 *
 * 위치=좌하단(우하단 아님). 우하단은 이미 toast.tsx(`fixed right-4`, 앱 전역 토스트)·
 * kanban-board.tsx 저장오류 배너(`fixed bottom-4 right-4`)가 선점한 자리라, 상주 런처를
 * 거기 얹으면 토스트가 뜰 때마다 겹친다(플로팅 UI 전뷰포트 충돌체크 원칙 — 이 결함 클래스를
 * 여기서 미리 피한다). 좌하단은 grep 확認상 선점 요소가 없다.
 *
 * 모바일(<lg=1024)에서는 MobileTabBar(mobile-tab-bar.tsx, `h-16` = 64px, 일반 flow — fixed
 * 아니지만 화면 최하단 전폭을 차지)가 lg:hidden으로 뜬다. 이 컴포넌트는 fixed(뷰포트 기준)
 * 라 문서 흐름과 무관하게 겹칠 수 있어, 모바일에서만 bottom 오프셋을 탭바 높이+여백만큼
 * 올린다(bottom-20 = 5rem = 64px+16px).
 *
 * ⚠️story #3260 후속(2026-08-31, 유나 post-deploy 라이브 실측 finding) — lg+(데스크톱)를
 * bottom-5로 되돌리면 AppSidebar(ui/sidebar.tsx)의 SidebarFooter(profile-menu.tsx
 * +locale-switcher.tsx+theme-toggle.tsx+business-info-disclosure.tsx, `space-y-2 p-2`)가
 * 항상 화면 좌하단에 그려지는데(사이드바 폭은 200~360px 사용자 조절 가능이지만 이 footer
 * 높이는 폭과 무관하게 고정) 그 위를 이 fixed 런처가 그대로 덮어 로케일/테마 토글이 가려지고
 * 「Business Information」(법적 표기) 행까지 피복했다 — 사이드바가 「선점 없음」 판정이었던
 * 최초 grep은 fixed 요소만 찾아 일반 flow인 이 footer를 놓쳤다. footer 실측 높이(profile
 * 40px+locale/theme 32px+business-info 28px+p-2·gap 32px ≈ 132px) 위로 넉넉히 띄운다
 * (lg:bottom-40=160px, ~28px 여유) — 모바일처럼 탭바 폭 무관 원칙과 동형(footer 높이도
 * 사이드바 폭과 무관).
 */
export function SupportWidgetLauncher() {
  const t = useTranslations('supportWidget');
  const [open, setOpen] = useState(false);
  const session = useSupportWidgetSession();

  useEffect(() => {
    if (open) session.connect();
  }, [open, session]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? t('closeLabel') : t('launcherLabel')}
        className="fixed bottom-20 left-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-foreground text-background shadow-lg transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 lg:bottom-40"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <LifeBuoy className="h-5 w-5" aria-hidden />}
      </button>
      {open ? (
        <div
          id={PANEL_ID}
          role="dialog"
          aria-label={t('panelTitle')}
          className="fixed bottom-[8.75rem] left-5 z-40 flex h-[min(480px,calc(100vh-11rem))] w-[360px] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl lg:bottom-56 lg:h-[min(480px,calc(100vh-15rem))]"
        >
          <SupportWidgetPanelHeader onClose={() => setOpen(false)} />
          <SupportWidgetPanelBody session={session} />
        </div>
      ) : null}
    </>
  );
}
