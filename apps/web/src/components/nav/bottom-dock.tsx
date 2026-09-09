'use client';

import { useToast, ToastContainer } from '@/components/ui/toast';
import { SupportWidgetLauncher } from '@/components/support-widget/support-widget-launcher';
import { isSupportWidgetEnabled } from '@/lib/support-widget-flag';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

/**
 * story #3759(FE·셸·결함 클래스, 유나 定 2026-09-09 20:55Z) — 우하단은 «한 열»이다. 토스트
 * (toast.tsx)·지원 위젯 런처(support-widget-launcher.tsx)·칸반 저장오류 배너
 * (kanban-board.tsx)가 각자 `fixed`로 자기 bottom을 계산하던 것(story #3756이 --bottom-
 * dock-inset 하나로는 통일했지만, 서로를 피하는 회피 상수는 각자 그대로 남아있었다 — 런처의
 * 5rem·패널의 8.75rem이 그 잔재)을 이 컴포넌트 하나가 대신한다: 이 컬럼이 우하단에 고정
 * 되고, 안의 자식들은 평범한 flexbox로만 쌓인다 — "몇 장이 쌓였든 그 위"가 계산 없이
 * 성립한다.
 *
 * `flex-col-reverse`이므로 DOM 순서(첫 자식→마지막 자식)가 시각 순서로는 아래→위다:
 * 배너 슬롯(가장 아래) → 토스트 스택 → 지원 런처(가장 위, 열려있으면 그 패널까지).
 *
 * 컬럼 자체는 `pointer-events-none`(내용이 없는 빈 구간을 클릭이 그대로 통과) — 실제
 * 상호작용 요소(토스트 카드·런처 버튼·패널·배너)는 각자 `pointer-events-auto`로 되돌린다
 * (toast.tsx·support-widget-launcher.tsx·kanban-board.tsx 각각 참고).
 *
 * 마운트 자리: dashboard-shell.tsx의 `<SidebarProvider className="... dashboard-shell-root">`
 * 안(ShellBody와 형제) — `--bottom-dock-inset`(story #3756)을 상속받아야 하고,
 * `useSidebar()`(SupportWidgetLauncher가 씀)도 SidebarProvider 후손이어야 한다.
 */
export function BottomDock() {
  const { toasts, dismissToast } = useToast();
  const { setBottomDockBannerSlot } = useDashboardContext();

  return (
    <div className="pointer-events-none fixed right-4 z-50 bottom-[calc(var(--bottom-dock-inset)+1rem)] flex flex-col-reverse items-end gap-2">
      {/* story #3759 — kanban-board.tsx가 자기 저장오류 배너를 이 노드로 포털한다
          (useDashboardContext().bottomDockBannerSlot). 노드 자체는 항상 마운트돼 있고
          비어있을 땐 아무 크기도 안 차지한다(`contents` — 배너가 없으면 컬럼 gap도 안 먹음,
          포털된 자식이 실제 크기를 갖는다). */}
      <div ref={setBottomDockBannerSlot} className="contents" />
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      {isSupportWidgetEnabled() && <SupportWidgetLauncher />}
    </div>
  );
}
