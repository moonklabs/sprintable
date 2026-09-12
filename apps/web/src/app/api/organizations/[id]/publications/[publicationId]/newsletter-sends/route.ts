import { apiSuccess } from '@/lib/api-response';
import { proxyToFastapiWithParams } from '@/lib/fastapi-proxy';

type RouteParams = { params: Promise<{ id: string; publicationId: string }> };

// story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — 뉴스레터 발송 요청. 백엔드
// backend/app/routers/newsletter_send.py::create_newsletter_send_endpoint 그대로
// 위임(boosts/route.ts와 동형 — 휴먼 전용은 BE가 이미 강제, 검증 로직 0). 라이브
// 회차 1(2026-09-12) 실측 — 이 프록시 라우트 부재로 발송 요청이 사용자 호스트
// 경로(dev-app)에서 404였다(BE 직접 호출은 PASS·FE 배선만 빠짐).
export async function POST(request: Request, { params }: RouteParams) {
  const { id, publicationId } = await params;
  const _r = await proxyToFastapiWithParams(
    request, '/api/v2/organizations/[id]/publications/[publicationId]/newsletter-sends', { id, publicationId },
  );
  if (!_r.ok) return _r;
  return apiSuccess(await _r.json());
}
