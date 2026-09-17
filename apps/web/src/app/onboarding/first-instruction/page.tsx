import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/db/server';
import { FirstInstructionRedirect } from './first-instruction-redirect';

// [SID:4021] 컴패니언 «첫 지시»가 여는 웹 주소. 데스크톱은 에이전트 키만 있어 대화 id를
// 얻지도 만들지도 못한다(onboarding_activation.py의 조회는 요청자=사람 참여 대화만·생성은
// fetchWithAuth) → 사람 세션인 이 웹뷰에서 그 에이전트와의 첫 지시 대화를 찾거나(중복 생성
// 방지·PO 보탬1) 없으면 웹이 이미 쓰는 createFirstInstructionConversation로 1회 만든 뒤
// `/chats/<id>?compose=<문구>`로 교체 이동한다. 전송은 사람이 대화 화면에서 누른다(에이전트
// 발신 0). 새 BE 0 · 레거시 `/chats` 목록 동작 무변.
interface FirstInstructionPageProps {
  // `agent` = 대상 에이전트 member_id · `compose` = 미리 채울 첫 지시 문구(URL 인코딩·빈값 허용).
  searchParams: Promise<{ agent?: string; compose?: string }>;
}

export default async function FirstInstructionPage({ searchParams }: FirstInstructionPageProps) {
  const { agent, compose } = await searchParams;

  // AC2 — 로그인 안 됨 → 기존 `/login?next=` 경로 그대로(invite/accept와 동일 패턴). 세션 복귀 뒤
  // 이 주소로 돌아와 아래 흐름을 탄다. proxy의 인증 가드도 같은 방향으로 튕기지만(양쪽 방어),
  // next를 이 페이지 쿼리까지 정확히 보존하려고 여기서도 명시 리다이렉트한다.
  const session = await getServerSession().catch(() => null);
  if (!session) {
    const qs = new URLSearchParams();
    if (agent) qs.set('agent', agent);
    if (compose) qs.set('compose', compose);
    const self = `/onboarding/first-instruction${qs.toString() ? `?${qs.toString()}` : ''}`;
    redirect(`/login?next=${encodeURIComponent(self)}`);
  }

  // AC1 — 프로젝트 id는 세션 기본 프로젝트(`getServerSession().project_id`). Firebase 세션 경로는
  // 이 값에 이미 `resolved_default_project_id` 폴백이 접혀 있다(lib/db/server.ts:101). 대화 생성 시
  // project_id로 쓴다. null이면 클라이언트가 «대화를 열 수 없어요» 안내로 간다(AC3).
  const projectId = session.project_id;

  return (
    <FirstInstructionRedirect
      agentId={agent ?? null}
      compose={compose ?? ''}
      projectId={projectId}
    />
  );
}
