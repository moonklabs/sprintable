import { proxyToFastapiWrapped } from '@/lib/fastapi-proxy';

/**
 * POST /api/billing/checkout — Toss 위젯 카드 인증(authKey) 완료 후 구독 체크아웃(#2510).
 * FastAPI로 직접 fetch하지 않고 이 프록시를 거치는 이유 — #2497에서 고친 X-Org-Id 브라우저
 * 인터셉터(same-origin /api/* 요청에만 주입)가 여기서만 적용된다. 결제처럼 잘못된 org로
 * 새면 안 되는 호출에 그 안전망을 반드시 태운다.
 *
 * proxyToFastapiWrapped — 성공 바디만 `{data}`로 재포장(에러는 BE 글로벌 핸들러가 이미
 * `{error:{code,message}}`로 감싸 그대로 통과) — 이 레포 envelope 관례와 일치.
 */
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapiWrapped(request, '/api/v2/org-subscriptions/checkout');
}
