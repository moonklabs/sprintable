import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string }> };

/** GET — 버전 히스토리 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/versions', { id });
}

/** POST — 버전 복원 */
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params;
  return proxyToFastapiWithParams(request, '/api/v2/mockups/[id]/versions', { id });
}
