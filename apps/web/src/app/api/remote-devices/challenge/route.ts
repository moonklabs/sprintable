import { proxyToFastapi } from '@/lib/fastapi-proxy';

// story 5027 — POST /api/v2/remote-devices/challenge: the one-time value a phone signs with the key it is registering (the proof that it holds that key's
// private key). Nothing is read from the request body or added to it: the server makes the value for the signed-in person and the organization of the request,
// and its answer is the answer (private · not stored).
export async function POST(request: Request): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/remote-devices/challenge');
}
