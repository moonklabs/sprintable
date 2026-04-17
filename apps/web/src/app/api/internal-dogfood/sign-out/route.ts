import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { INTERNAL_DOGFOOD_COOKIE, isInternalDogfoodEnabled } from '@/lib/internal-dogfood';

export async function POST(request: Request) {
  if (!isInternalDogfoodEnabled()) return apiError('NOT_FOUND', 'Not found', 404);

  const url = new URL('/internal-dogfood', request.url);
  url.searchParams.set('signed_out', '1');
  const response = NextResponse.redirect(url);
  response.cookies.set(INTERNAL_DOGFOOD_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
