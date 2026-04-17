import { NextResponse } from 'next/server';
import { getInternalDogfoodContext } from '@/lib/internal-dogfood-server';
import { createInternalDogfoodStoryInSprintable } from '@/services/internal-dogfood-sprintable';

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
  const description = String(formData.get('description') ?? '').trim();
  const assigneeId = String(formData.get('assignee_id') ?? '').trim() || null;
  const status = String(formData.get('status') ?? '').trim() || 'backlog';
  const priority = String(formData.get('priority') ?? '').trim() || 'medium';

  if (!title) {
    return NextResponse.redirect(redirectToInternalDogfood(request, { error: 'story_title_required' }));
  }

  const story = await createInternalDogfoodStoryInSprintable(context.supabase, context.actor, {
    title,
    description: description || null,
    assigneeId,
    status,
    priority,
  });

  return NextResponse.redirect(redirectToInternalDogfood(request, { created_story_id: String((story as { id: string }).id) }));
}
