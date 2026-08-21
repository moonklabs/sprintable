import { LoopQueueClient } from '@/components/loop-queue/loop-queue-client';

// story #2858(loop-closure P2) — 「닫히지 않은 루프」 전량 큐. org-briefing 클러스터(타입당
// top-20 요약)와 달리 이 페이지는 «전부»가 목적이라 별도 라우트로 둔다(org 스코프, 프로젝트
// 경로 비의존 — /flow?goal=처럼 cross-project 항목을 한 화면에 같이 보여줘야 해서).
export default function LoopQueuePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <LoopQueueClient />
    </div>
  );
}
