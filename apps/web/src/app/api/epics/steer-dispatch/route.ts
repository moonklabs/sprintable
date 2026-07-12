import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST /api/epics/steer-dispatch — STEER v2 조타 커밋(story 2628a53b·BE #2086).
 * 드래그(/epics/bulk)는 무이벤트 초안 저장이고, 이 명시적 커밋에서만 epic.reordered 1회 발화한다.
 * payload={items:[{id,position}](커밋 스냅샷), recipient_member_ids:[uuid](필수)}.
 *
 * proxyToFastapiWrapped 사용 이유: BE 상태코드를 그대로 forward해야 한다 — 특히 **409**(스냅샷
 * position≠저장·"save draft before dispatch")를 클라가 구분해 재확認 UX를 띄운다. 리포지토리
 * (fastapiCall) 경로는 mapApiError가 409를 일반 Error로 뭉개 handleApiError서 400으로 붕괴시킨다.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/epics/steer-dispatch');
}
