import { DesktopDownloadCard } from '@/components/desktop/desktop-download-card';

/**
 * story #3807 AC3(페드루 PO 確定 2026-09-11) — dev-app 다운로드 자리. 카드 「범위」
 * 3번이 명시한 후보 중 `/desktop`을 채택(민 AC2 매니페스트 경로
 * `/desktop/updates/macos.json`과 같은 네임스페이스 — 사람 화면·기계 매니페스트가
 * 자매 경로, 새 경로 규약 발명 0). 화면 최소(카드 1개) — UI 재편은 이 카드 범위 밖
 * (선생님 지시, 카드 근거 §3 인용).
 */
export default function DesktopPage() {
  return (
    <div className="mx-auto w-full max-w-3xl p-6">
      <DesktopDownloadCard />
    </div>
  );
}
