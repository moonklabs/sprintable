import { type NextRequest } from 'next/server';
import { proxyToFastapi } from '@/lib/fastapi-proxy';

export async function GET(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/conversations');
}

export async function POST(request: NextRequest): Promise<Response> {
  return proxyToFastapi(request, '/api/v2/conversations');
}
