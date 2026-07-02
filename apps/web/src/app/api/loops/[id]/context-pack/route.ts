import { proxyToFastapi } from '@/lib/fastapi-proxy';

// GET /api/loops/[id]/context-pack → FastAPI GET /api/v2/loops/{id}/context-pack (E-LOOP-LEDGER S12).
// ⚠️ S13 착수 시점(handoff e-loop-ledger-s13-context-pack-handoff §3) 기준 BE 엔드포인트 미착지 —
// PO-locked 계약 shape(디디 S12 착수용, 목업이 정의)에 맞춰 UI+프록시만 먼저 준비. S12 머지되면
// 라이브 연결(이 파일은 변경 불필요 — 순수 passthrough).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  return proxyToFastapi(request, `/api/v2/loops/${id}/context-pack`);
}
