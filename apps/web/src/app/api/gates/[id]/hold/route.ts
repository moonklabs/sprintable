import { proxyToFastapi } from '@/lib/fastapi-proxy';

// E-DG S31: admin gate 보류(hold) 프록시. BE POST /api/v2/gates/{id}/hold {reason?, held_until?}
// (디디 BE 병렬·머지되면 body 계약 정합·admin+holder=caller는 BE 강제). void/transition 동형 raw passthrough.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/gates/${id}/hold`);
}
