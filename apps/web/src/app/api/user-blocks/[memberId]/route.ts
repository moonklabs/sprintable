import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

/**
 * DELETE /api/user-blocks/{memberId} — story #2349. BE
 * `DELETE /api/v2/user-blocks/{member_id}`를 그대로 통과시킨다(사용자 차단 해제).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<Response> {
  const { memberId } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/user-blocks/[memberId]', { memberId });
}
