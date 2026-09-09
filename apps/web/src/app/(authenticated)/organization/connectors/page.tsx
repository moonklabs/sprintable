import { redirect } from 'next/navigation';

// story #3743(UI 재설계 ③, 페드루 PO 決 2026-09-09) — 이 화면(4180f67f)의 정보(커넥터
// 준비 상태)가 organization/channels의 「담당 에이전트가 설정하는 것」 구획으로 흡수됐다
// (agent-setup-section.tsx). 라우트 자체는 남겨 리다이렉트만 한다 — 북마크·딥링크·아직
// 못 걷은 외부 참조(agent 스킬 안내 문구 등)가 있을 수 있어 404보다 안전하다.
export default function OrganizationConnectorsRedirectPage() {
  redirect('/organization/channels');
}
