import { redirect } from 'next/navigation';

// story #2054(AC4): 이 화면은 원래 빈 스텁(`return null`)이라 HitlRequest 승인 대기가 어디에도
// 안 뜨는 근본원인 중 하나였다 — 통합 인박스(`/inbox` 결재함 탭, ApprovalsQueue)가 Gate와
// HitlRequest를 함께 보여주는 정식 표면이 됐으니, 이 라우트로 오는 기존 링크/북마크 사용자를
// 그쪽으로 안내한다(기존 화면 사용자를 빈 화면에 버리지 않는다).
export default function AgentHitlRequestsPage() {
  redirect('/inbox');
}
