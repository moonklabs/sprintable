import { NextResponse } from 'next/server';
import { getInternalDogfoodContext } from '@/lib/internal-dogfood-server';
import { createInternalDogfoodMemoInSprintable } from '@/services/internal-dogfood-sprintable';

function redirectToInternalDogfood(request: Request, params: Record<string, string>) {
  const url = new URL('/internal-dogfood', request.url);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

export async function POST(request: Request) {
  const context = await getInternalDogfoodContext();
  if ('errorResponse' in context) return context.errorResponse;

  const formData = await request.formData();
  const title = String(formData.get('title') ?? '').trim();
  const content = String(formData.get('content') ?? '').trim();
  const memoType = String(formData.get('memo_type') ?? '').trim() || 'memo';
  const assignedTo = String(formData.get('assigned_to') ?? '').trim() || null;

  if (!content) {
    return NextResponse.redirect(redirectToInternalDogfood(request, { error: 'memo_content_required' }));
  }

  const memo = await createInternalDogfoodMemoInSprintable(context.db, context.actor, {
    title: title || null,
    content,
    memoType,
    assignedTo,
  });

  return NextResponse.redirect(redirectToInternalDogfood(request, { created_memo_id: String((memo as { id: string }).id) }));
}
