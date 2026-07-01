import { proxyToFastapi } from '@/lib/fastapi-proxy';
import { apiSuccess } from '@/lib/api-response';

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/docs/[id]/summary → { title, slug } only (E-LOOP-LEDGER S6: loop 상세의 brief_doc_id
// 링크 해석용). 전체 DocResponse(content 포함)를 그대로 넘기지 않고 링크에 필요한 필드만 추린다.
export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  const res = await proxyToFastapi(request, `/api/v2/docs/${id}`);
  if (!res.ok) return res;
  const doc = (await res.json()) as { id: string; title: string; slug: string };
  return apiSuccess({ id: doc.id, title: doc.title, slug: doc.slug });
}
