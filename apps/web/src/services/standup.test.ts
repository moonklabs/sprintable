import type { SupabaseClient } from '@/types/supabase';
import { describe, expect, it } from 'vitest';
import { StandupFeedbackService, StandupService } from './standup';

describe('StandupService.save', () => {
  it('persists linked story ids with the standup entry', async () => {
    let payload: Record<string, unknown> | null = null;

    const db = {
      from(table: string) {
        if (table === 'standup_entries') {
          return {
            upsert(nextPayload: Record<string, unknown>) {
              payload = nextPayload;
              return this;
            },
            select() { return this; },
            single: async () => ({
              data: {
                id: 'entry-1',
                ...(payload ?? {}),
              },
              error: null,
            }),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as SupabaseClient;

    const service = new StandupService(db);
    const entry = await service.save({
      project_id: 'project-1',
      org_id: 'org-1',
      author_id: 'member-1',
      date: '2026-04-10',
      done: 'done',
      plan: 'plan',
      blockers: null,
      sprint_id: 'sprint-1',
      plan_story_ids: ['story-1', 'story-2'],
    });

    expect(payload).toMatchObject({
      project_id: 'project-1',
      org_id: 'org-1',
      author_id: 'member-1',
      date: '2026-04-10',
      sprint_id: 'sprint-1',
      plan_story_ids: ['story-1', 'story-2'],
    });
    expect(entry.plan_story_ids).toEqual(['story-1', 'story-2']);
  });
});

describe('StandupFeedbackService', () => {
  it('loads feedback by standup date', async () => {
    const db = {
      from(table: string) {
        if (table === 'standup_entries') {
          return {
            select() { return this; },
            eq() { return this; },
            then: (resolve: (value: { data: Array<{ id: string }>; error: null }) => void) => Promise.resolve({
              data: [{ id: 'entry-1' }, { id: 'entry-2' }],
              error: null,
            }).then(resolve),
          };
        }

        if (table === 'standup_feedback') {
          return {
            select() { return this; },
            eq() { return this; },
            in() { return this; },
            order() { return this; },
            then: (resolve: (value: { data: Array<{ id: string; standup_entry_id: string }>; error: null }) => void) => Promise.resolve({
              data: [{ id: 'feedback-1', standup_entry_id: 'entry-1' }],
              error: null,
            }).then(resolve),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as SupabaseClient;

    const service = new StandupFeedbackService(db);
    const feedback = await service.listByDate('project-1', '2026-04-10');

    expect(feedback).toEqual([{ id: 'feedback-1', standup_entry_id: 'entry-1' }]);
  });

  it('creates feedback with the reviewer as the author', async () => {
    let insertPayload: Record<string, unknown> | null = null;

    const db = {
      from(table: string) {
        if (table === 'standup_entries') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({
              data: {
                id: 'entry-1',
                org_id: 'org-1',
                project_id: 'project-1',
                sprint_id: 'sprint-1',
              },
              error: null,
            }),
          };
        }

        if (table === 'standup_feedback') {
          return {
            insert(payload: Record<string, unknown>) {
              insertPayload = payload;
              return this;
            },
            select() { return this; },
            single: async () => ({
              data: {
                id: 'feedback-1',
                ...(insertPayload ?? {}),
              },
              error: null,
            }),
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as SupabaseClient;

    const service = new StandupFeedbackService(db);
    const feedback = await service.create({
      project_id: 'project-1',
      org_id: 'org-1',
      standup_entry_id: 'entry-1',
      feedback_by_id: 'member-2',
      review_type: 'approve',
      feedback_text: '  looks good  ',
    });

    expect(insertPayload).toMatchObject({
      org_id: 'org-1',
      project_id: 'project-1',
      sprint_id: 'sprint-1',
      standup_entry_id: 'entry-1',
      feedback_by_id: 'member-2',
      review_type: 'approve',
      feedback_text: 'looks good',
    });
    expect(feedback.feedback_text).toBe('looks good');
  });

  it('rejects updates from non-authors', async () => {
    const db = {
      from(table: string) {
        if (table === 'standup_feedback') {
          return {
            select() { return this; },
            eq() { return this; },
            single: async () => ({
              data: { id: 'feedback-1', feedback_by_id: 'member-1' },
              error: null,
            }),
            update() { return this; },
          };
        }

        return {
          select() { return this; },
          eq() { return this; },
          single: async () => ({ data: null, error: null }),
        };
      },
    } as unknown as SupabaseClient;

    const service = new StandupFeedbackService(db);
    await expect(service.update('feedback-1', { feedback_text: 'change' }, 'member-2')).rejects.toThrow('Permission denied');
  });
});
