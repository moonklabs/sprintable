import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * DELETE /api/stories/{id}/rejected-relations/{targetId} — story #2357. BE
 * `DELETE /api/v2/stories/{id}/rejected-relations/{target_id}`를 그대로 통과시킨다 —
 * 되살리기(`rejected_relations` 행 삭제). 되살려도 candidate 행이 즉시 돌아오지 않는다 —
 * 다음 story 저장이 있어야 새 후보가 생긴다(BE docstring, "새 참조만" 설계 원칙). 그래서
 * 화면 문구도 "다시 후보로 올라올 수 있습니다"까지만 말하고 시점을 약속하지 않는다.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; targetId: string }> },
): Promise<Response> {
  const { id, targetId } = await params;
  return proxyToFastapiWithParams(
    request,
    '/api/v2/stories/[id]/rejected-relations/[targetId]',
    { id, targetId },
  );
}
