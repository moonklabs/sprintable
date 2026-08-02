import { NextResponse } from 'next/server';
import { getInternalDogfoodContext } from '@/lib/internal-dogfood-server';
import { createInternalDogfoodStoryInSprintable } from '@/services/internal-dogfood-sprintable';
import { resolveAppUrl } from '@/services/app-url';

// story #1933 — request.url을 base로 쓰면 Cloud Run 내부 주소가 샌다. resolveAppUrl(null)로
// 공개 주소를 강제한다(request는 더 이상 필요 없다).
function redirectToInternalDogfood(params: Record<string, string>) {
  const url = new URL('/internal-dogfood', resolveAppUrl(null));
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
    return NextResponse.redirect(redirectToInternalDogfood({ error: 'story_title_required' }));
  }

  const story = await createInternalDogfoodStoryInSprintable(context.db, context.actor, {
    title,
    description: description || null,
    assigneeId,
    status,
    priority,
  });

  return NextResponse.redirect(redirectToInternalDogfood({ created_story_id: String((story as { id: string }).id) }));
}
