import { proxyToFastapi } from '@/lib/fastapi-proxy';

/** DELETE /api/references/{id} — 되돌리는 길(#2582 계약 필수 요건): 사람이 「확인」을
 * 잘못 눌렀을 때 그 자리에서 취소. raw passthrough(dependencies/[id] DELETE와 동형). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/references/${id}`);
}
