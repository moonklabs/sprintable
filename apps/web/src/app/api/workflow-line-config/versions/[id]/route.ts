import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S34: 단일 version 로드(GET·config 포함) + draft in-place 저장(PATCH·#1647·published 422). admin·raw.
type P = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: P): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-line-config/versions/${id}`);
}
export async function PATCH(request: Request, { params }: P): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-line-config/versions/${id}`);
}
