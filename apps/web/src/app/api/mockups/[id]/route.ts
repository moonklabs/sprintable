import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 목업 상세 (컴포넌트 포함) */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]', { id });
}

/** PUT — 목업 수정 (컴포넌트 트리 일괄 교체) */
export async function PUT(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]', { id });
}

/** DELETE — 목업 소프트 삭제 */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]', { id });
}
