import { redirect } from 'next/navigation';
import { DesktopDownloadCard } from '@/components/desktop/desktop-download-card';
import { isDesktopDownloadEnabled } from '@/lib/desktop-download-gate';

/**
 * story #3807 AC3(페드루 PO 確定 2026-09-11) — dev-app 다운로드 자리. 카드 「범위」
 * 3번이 명시한 후보 중 `/desktop`을 채택(민 AC2 매니페스트 경로
 * `/desktop/updates/macos.json`과 같은 네임스페이스 — 사람 화면·기계 매니페스트가
 * 자매 경로, 새 경로 규약 발명 0). 화면 최소(카드 1개) — UI 재편은 이 카드 범위 밖
 * (선생님 지시, 카드 근거 §3 인용).
 *
 * story #4012(critical·prod 승격 준비, 페드루 PO 確定 2026-09-17) — Apple 공증
 * (선생님 몫 ⑧) 완료 전까지 prod에서 이 화면을 끈다. 서버 컴포넌트라 이 판정은
 * process.env.DEPLOY_ENV(서버 전용, NEXT_PUBLIC_ 아님)로 이뤄져 클라이언트
 * 번들에 실리지 않는다 — `apps/web/src/app/page.tsx`(루트 서버 리다이렉트)와
 * 같은 패턴, 대상은 로그인 후 홈(`/org-briefing`, proxy.ts의 기본 착지와 동형).
 */
export default function DesktopPage() {
  if (!isDesktopDownloadEnabled(process.env.DEPLOY_ENV)) {
    redirect('/org-briefing');
  }

  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <DesktopDownloadCard />
    </div>
  );
}
