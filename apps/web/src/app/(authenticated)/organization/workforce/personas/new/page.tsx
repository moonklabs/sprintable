import { notFound } from 'next/navigation';

// story #2235: managed agent 페르소나 작성기 앞단 전량 삭제(선생님 결재).
// page.tsx 삭제 시 (authenticated) layout 밖 루트 404로 잡혀 사이드바 없는 기본 404가 나옴 →
// workflow/page.tsx와 동일한 thin guard 패턴 유지.
export default function Page() {
  notFound();
}
