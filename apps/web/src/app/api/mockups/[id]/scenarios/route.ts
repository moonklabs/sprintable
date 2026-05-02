import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 시나리오 목록 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
}

/** POST — 시나리오 생성 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
}

/** PATCH — 시나리오 수정 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
}

/** DELETE — 시나리오 삭제 (default 불가) */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/scenarios', { id });
}
