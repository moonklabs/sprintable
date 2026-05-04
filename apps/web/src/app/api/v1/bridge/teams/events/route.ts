const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('Content-Type') ?? 'application/json',
  };
  const auth = request.headers.get('authorization');
  if (auth) headers['authorization'] = auth;

  const res = await fetch(`${FASTAPI_URL()}/api/v2/bridge/teams/events`, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  const json = await res.json().catch(() => ({}));
  return Response.json(json, { status: res.status });
}
