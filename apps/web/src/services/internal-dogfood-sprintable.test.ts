import type { SupabaseClient } from '@/types/supabase';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMemoAssignmentImmediately } = vi.hoisted(() => ({
  dispatchMemoAssignmentImmediately: vi.fn(async () => undefined),
}));

vi.mock('./memo-assignment-dispatch', () => ({
  dispatchMemoAssignmentImmediately,
}));

import { createInternalDogfoodMemoInSprintable } from './internal-dogfood-sprintable';

describe('createInternalDogfoodMemoInSprintable', () => {
  beforeEach(() => {
    dispatchMemoAssignmentImmediately.mockReset();
  });

  it('writes memos directly and dispatches the inserted memo without extra reads', async () => {
    const insertPayloads: Array<Record<string, unknown>> = [];

    const db = {
      from(table: string) {
        if (table === 'memos') {
          const builder = {
            insert(payload: Record<string, unknown>) {
              insertPayloads.push(payload);
              return builder;
            },
            select() {
              return builder;
            },
            single: async () => ({
              data: {
                id: 'memo-1',
                org_id: 'org-1',
                project_id: 'project-1',
                title: 'Internal blocker',
                content: 'memo body',
                memo_type: 'task',
                status: 'open',
                assigned_to: 'agent-1',
                created_by: 'tm-1',
                metadata: { internal_dogfood: true },
                updated_at: '2026-04-10T10:00:00.000Z',
                created_at: '2026-04-10T10:00:00.000Z',
              },
              error: null,
            }),
          };
          return builder;
        }

        throw new Error(`Unexpected table read: ${table}`);
      },
    } as unknown as SupabaseClient;

    const result = await createInternalDogfoodMemoInSprintable(
      db,
      { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
      {
        title: 'Internal blocker',
        content: 'memo body',
        memoType: 'task',
        assignedTo: 'agent-1',
      },
    );

    expect(result).toMatchObject({ id: 'memo-1', content: 'memo body', assigned_to: 'agent-1' });
    expect(insertPayloads).toEqual([
      expect.objectContaining({
        project_id: 'project-1',
        org_id: 'org-1',
        title: 'Internal blocker',
        content: 'memo body',
        memo_type: 'task',
        assigned_to: 'agent-1',
        created_by: 'tm-1',
        metadata: { internal_dogfood: true },
      }),
    ]);
    expect(dispatchMemoAssignmentImmediately).toHaveBeenCalledTimes(1);
    expect(dispatchMemoAssignmentImmediately).toHaveBeenCalledWith(expect.objectContaining({
      id: 'memo-1',
      org_id: 'org-1',
      project_id: 'project-1',
      created_by: 'tm-1',
      assigned_to: 'agent-1',
    }));
  });
});
