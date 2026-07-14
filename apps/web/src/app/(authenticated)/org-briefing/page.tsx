import { OrgBriefingShell } from '@/components/org-briefing/org-briefing-shell';

// story ded31cb3 — 조직 브리핑, 지금/Now 존 새 기본 랜딩(칸반 강등·1급 화면 대체). 기존 대시보드
// (/dashboard)·인박스(/inbox) 라우트는 무변경 공존(회귀 0) — root page.tsx 리다이렉트만 이 라우트로 전환.
export default function OrgBriefingPage() {
  return <OrgBriefingShell />;
}
