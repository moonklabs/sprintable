import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/dependencies/${id}`);
}

// story #2258 AC3: 대기 해제 조건(dep_type) «수정» — BE PATCH를 그대로 프록시.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/dependencies/${id}`);
}
