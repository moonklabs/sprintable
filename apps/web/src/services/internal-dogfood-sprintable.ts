// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import type { InternalDogfoodActor } from '@/lib/internal-dogfood';
import { dispatchMemoAssignmentImmediately, type DispatchableMemo } from './memo-assignment-dispatch';

export async function createInternalDogfoodMemoInSprintable(
  supabase: SupabaseClient,
  actor: InternalDogfoodActor,
  input: {
    title?: string | null;
    content: string;
    memoType: string;
    assignedTo?: string | null;
  },
) {
  const memoPayload = {
    org_id: actor.org_id,
    project_id: actor.project_id,
    title: input.title ?? null,
    content: input.content,
    memo_type: input.memoType,
    assigned_to: input.assignedTo ?? null,
    created_by: actor.id,
    metadata: { internal_dogfood: true },
  };

  const { data, error } = await supabase
    .from('memos')
    .insert(memoPayload)
    .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, metadata, updated_at, created_at')
    .single();

  if (error) throw error;
  if (!data) throw new Error('failed to create internal dogfood memo');

  await dispatchMemoAssignmentImmediately(data as DispatchableMemo);
  return data;
}

export async function createInternalDogfoodStoryInSprintable(
  supabase: SupabaseClient,
  actor: InternalDogfoodActor,
  input: {
    title: string;
    description?: string | null;
    assigneeId?: string | null;
    status: string;
    priority: string;
  },
) {
  const { data, error } = await supabase
    .from('stories')
    .insert({
      org_id: actor.org_id,
      project_id: actor.project_id,
      title: input.title,
      description: input.description ?? null,
      assignee_id: input.assigneeId ?? null,
      status: input.status,
      priority: input.priority,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}
