import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S34: publish 요청(POST)→workflow_config_publish gate 생성(GateInbox서 승인·self-approval 방지). BE .../versions/{id}/request-publish. admin·raw.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/workflow-line-config/versions/${id}/request-publish`);
}
