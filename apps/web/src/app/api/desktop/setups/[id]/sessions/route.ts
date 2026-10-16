import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story #4543 (PO 21:12Z) — GET /api/v2/desktop/setups/{id}/sessions proxy (org owner/admin person session · backend
// routers/desktop_relay.py get_device_sessions): a device's sessions, live first, `?limit=` (≤ 200) passed through. Each row carries
// created_at · ended_at for the crew's daily ledger. Shape-only check here, as the setup route next door.
const SETUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams): Promise<Response> {
  const { id } = await params;
  if (!SETUP_ID.test(id)) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  return proxyToFastapi(request, `/api/v2/desktop/setups/${id}/sessions`);
}
