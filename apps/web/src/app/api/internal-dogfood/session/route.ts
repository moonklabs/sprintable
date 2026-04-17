import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api-response';
import {
  INTERNAL_DOGFOOD_COOKIE,
  encodeInternalDogfoodSession,
  isInternalDogfoodEnabled,
  resolveInternalDogfoodActor,
} from '@/lib/internal-dogfood';

function redirectToInternalDogfood(request: Request, params: Record<string, string>) {
  const url = new URL('/internal-dogfood', request.url);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

export async function POST(request: Request) {
  if (!isInternalDogfoodEnabled()) {
    return apiError('NOT_FOUND', 'Not found', 404);
  }

  const formData = await request.formData();
  const secret = String(formData.get('secret') ?? '');
  const teamMemberId = String(formData.get('team_member_id') ?? '').trim();
  const expectedSecret = process.env['INTERNAL_DOGFOOD_ACCESS_SECRET']?.trim();

  if (!expectedSecret) {
    return apiError('INTERNAL_ERROR', 'Internal dogfood access secret missing', 500);
  }

  if (!teamMemberId) {
    return NextResponse.redirect(redirectToInternalDogfood(request, { error: 'team_member_required' }));
  }

  if (secret !== expectedSecret) {
    return NextResponse.redirect(redirectToInternalDogfood(request, { error: 'invalid_secret' }));
  }

  const actor = resolveInternalDogfoodActor(teamMemberId);
  if (!actor) {
    return NextResponse.redirect(redirectToInternalDogfood(request, { error: 'member_not_allowed' }));
  }

  const response = NextResponse.redirect(redirectToInternalDogfood(request, { actor: actor.id }));
  response.cookies.set({
    name: INTERNAL_DOGFOOD_COOKIE,
    value: encodeInternalDogfoodSession({
      teamMemberId: actor.id,
      orgId: actor.org_id,
      projectId: actor.project_id,
      issuedAt: Math.floor(Date.now() / 1000),
    }),
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: Number(process.env['INTERNAL_DOGFOOD_ACCESS_MAX_AGE_SECONDS'] ?? 60 * 60 * 12),
  });
  return response;
}
