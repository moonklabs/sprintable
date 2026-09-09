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
    // story #3759 CHANGES(유나 定+페드루 判 동의, #4106) — 위치는 이 컬럼이 갖는데
    // 높이 예산은 안 갖고 있었다: 컬럼에 상한이 없고 패널은 고정 높이(shrink 없음)라
    // 토스트가 끼면 패널이 그만큼 밀려 올라가기만 했다(375×667·토스트 1장에서 패널
    // top이 -31 — #3756이 세운 "패널 top ≥ 0"을 깬 회귀). 이제 컬럼 자신이 높이
    // 예산의 주인이다 — max-h로 뷰포트를 못 넘게 막고(min-h-0으로 flex 자식들이
    // 그 예산 안에서 실제로 다툴 수 있게), 무엇이 밀려날지는 자식별 shrink 설정으로
    // 정한다(패널=shrink-0 절대 안 줄어듦 · 토스트 스택=넘치면 스스로 자름,
    // toast.tsx ToastContainer 참고).
    //
    // 로컬 puppeteer 실측(375×667, 패널 열림, 헤드리스 크롬 실레이아웃 — jsdom엔 레이아웃
    // 엔진이 없어 이 수치는 여기 주석으로만 남긴다, doc-editor.tsx 관례와 동형): 토스트
    // 0/1/2/3/5장에서 패널 top = 121/47/16/16/16px — 세 CSS 처방이 전부 있으면 몇 장이든
    // 음수(뷰포트 위로 넘침)로 떨어지지 않는다(컬럼 max-h가 다 찬 뒤로는 토스트 스택이
    // min-h-0으로 스스로 줄어 패널 위치를 더 흔들지 않음). 같은 측정에서 토스트 스택은
    // 항상 최신(toasts 배열의 마지막 원소)이 스택 자기 박스 안에 남고, 오래된 것부터
    // 차례로 그 박스 위로 밀려나 overflow-hidden에 잘린다(5장 측정: 최신 1장만 박스 안,
    // 나머지 4장은 박스 밖 — clip-oldest-first가 실제 픽셀에서도 성립).
    <div className="pointer-events-none fixed right-4 z-50 bottom-[calc(var(--bottom-dock-inset)+1rem)] flex max-h-[calc(100vh-var(--bottom-dock-inset)-2rem)] min-h-0 flex-col-reverse items-end gap-2">
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
