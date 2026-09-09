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
    // 그 예산 안에서 실제로 다툴 수 있게), 무엇이 밀려날지는 자식별 min-height 바닥으로
    // 정한다.
    //
    // story #3759 CHANGES 2차(유나 定+페드루 判, #4106 — 정정 캡처: 패널 top≥0인데 최신
    // 토스트가 27px 조각으로만 잘려 보이는 걸 실제로 보고 내린 판정) — 처음엔 패널이
    // shrink-0(절대 안 줄어듦)·토스트 스택이 min-h-0(0까지 눌릴 수 있음)이라, 패널이
    // 예산을 다 쓰면 토스트가 최신까지 조각났다. 우선순위를 다시 매겼다: «토스트 1장
    // (항상 온전) > 패널 > 토스트 2장째부터». 패널은 shrink-0을 걷고 min-h-0을 줘 양보하는
    // 쪽이 됐다(자기 overflow-y-auto로 스크롤되니 줄어도 내용을 안 잃는다 — 토스트는
    // 조각나면 되돌리기 버튼을 못 누르는 거짓 어포던스가 되니 다르다).
    //
    // story #3759 CHANGES 3차(유나 ⛔+페드루 判, #4106) — CHANGES 2차는 «토스트 1장 항상
    // 온전»을 min-h-[5.5rem](88px) 수치 바닥으로 세웠는데, 배포된 CSS 위 실 클래스 주입
    // 실측에서 제목만 58px·제목+짧은 본문 74px·제목+두 줄 감기는 본문 90px — 88이 90을
    // 2px 못 덮어 보통 문안(두 줄 감김)에서 최신이 다시 조각났다(#3759 자체가 «회피 상수를
    // 수식에서 없앤» 스토리인데 그 자리에 내용 높이를 따라가야 하는 새 상수가 들어온 모순
    // — 캡처 픽스처가 한 줄이라 가려졌던 축). 수치 바닥을 걷고 구조로: toast.tsx
    // ToastContainer가 최신 한 장만 별도 `shrink-0` 래퍼로 분리한다 — 그 장의 실제 높이가
    // 58이든 74든 90이든 shrink-0은 무조건 안 줄어듦을 보장(수치 비교 필요 0). 나머지는
    // 별도 `min-h-0 overflow-hidden` 서브스택이 넘치는 몫을 진다.
    //
    // 로컬 puppeteer 실측(375×667, 패널 열림+내용 채움, 헤드리스 크롬 실레이아웃 — jsdom엔
    // 레이아웃 엔진이 없어 이 수치는 여기 주석으로만 남긴다, doc-editor.tsx 관례와 동형):
    // «두 줄로 감기는 본문»(CHANGES 2차가 놓쳤던 축) 픽스처를 최신 토스트로 두고 토스트
    // 0/1/2/3/5장·패널 열림에서 최신 높이 == 그 토스트 단독 자연 높이(잘림 0) — 항상 참,
    // 최신 카드 높이가 43px(제목만)이든 98px(두 줄 본문)이든 동일하게 성립(수치 무관 —
    // shrink-0이 구조로 보장하므로). 패널 top도 몇 장이든 음수로 안 떨어짐(1장: 23·5장:
    // 16). toast.tsx ToastContainer 참고.
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
