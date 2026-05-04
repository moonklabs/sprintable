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

  const res = await fetch(`${FASTAPI_URL()}/api/v2/bridge/slack/events`, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  const json = await res.json().catch(() => ({}));
  return Response.json(json, { status: res.status });
}
