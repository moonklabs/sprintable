import { backendFetch } from '@/lib/backend-fetch';
const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
  };
  for (const h of ['x-slack-signature', 'x-slack-request-timestamp']) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }

  const res = await backendFetch(`${FASTAPI_URL()}/api/v2/bridge/slack/events`, {
    // story #4320 — 외부 웹훅 전달 — 보내는 쪽(Slack 3초 제한)이 끊어도 백엔드 처리 결과를 버리지 않는다. 시간 제한만.
    timeLimitOnly: true,
    method: 'POST',
    headers,
    body: rawBody,
  });

  const json = await res.json().catch(() => ({}));
  return Response.json(json, { status: res.status });
}
