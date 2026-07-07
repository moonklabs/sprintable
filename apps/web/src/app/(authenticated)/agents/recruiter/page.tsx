import { redirect } from 'next/navigation';

/**
 * 에이전트 관리 IA 통일(story d63d3f73) — 채용은 `/agents` 채용 탭으로 흡수.
 * 기존 "채용관" CTA·딥링크 보존을 위해 이 경로는 탭으로 리다이렉트만 한다.
 */
export default function RecruiterPage() {
  redirect('/agents?tab=recruit');
}
