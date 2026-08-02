import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import { INTERNAL_DOGFOOD_COOKIE, isInternalDogfoodEnabled } from '@/lib/internal-dogfood';
import { resolveAppUrl } from '@/services/app-url';

export async function POST() {
  if (!isInternalDogfoodEnabled()) return apiError('NOT_FOUND', 'Not found', 404);

  // story #1933 — request.url을 base로 쓰면 Cloud Run 내부 주소가 샌다. resolveAppUrl(null)로
  // 공개 주소를 강제한다.
  const url = new URL('/internal-dogfood', resolveAppUrl(null));
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
