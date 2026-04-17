import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getInternalDogfoodContext, createMemo } = vi.hoisted(() => ({
  getInternalDogfoodContext: vi.fn(),
  createMemo: vi.fn(),
}));

vi.mock('@/lib/internal-dogfood-server', () => ({
  getInternalDogfoodContext,
}));

vi.mock('@/services/internal-dogfood-sprintable', () => ({
  createInternalDogfoodMemoInSprintable: createMemo,
}));

import { POST } from './route';

describe('POST /api/internal-dogfood/memos', () => {
  beforeEach(() => {
    getInternalDogfoodContext.mockReset();
    createMemo.mockReset();
  });

  it('creates a memo with the internal actor scope', async () => {
    getInternalDogfoodContext.mockResolvedValue({
      supabase: { tag: 'admin' },
      actor: { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
    });
    createMemo.mockResolvedValue({ id: 'memo-1' });

    const formData = new FormData();
    formData.set('title', 'Internal blocker');
    formData.set('content', 'memo body');
    formData.set('memo_type', 'task');
    formData.set('assigned_to', 'agent-1');

    const response = await POST(new Request('http://localhost/api/internal-dogfood/memos', {
      method: 'POST',
      body: formData,
    })) as Response;

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('created_memo_id=memo-1');
    expect(createMemo).toHaveBeenCalledWith(
      { tag: 'admin' },
      expect.objectContaining({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' }),
      expect.objectContaining({
        title: 'Internal blocker',
        content: 'memo body',
        memoType: 'task',
        assignedTo: 'agent-1',
      }),
    );
  });

  it('returns the context error response when session is missing', async () => {
    getInternalDogfoodContext.mockResolvedValue({
      errorResponse: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    });

    const formData = new FormData();
    formData.set('content', 'memo body');

    const response = await POST(new Request('http://localhost/api/internal-dogfood/memos', {
      method: 'POST',
      body: formData,
    })) as Response;

    expect(response.status).toBe(401);
    expect(createMemo).not.toHaveBeenCalled();
  });
});
