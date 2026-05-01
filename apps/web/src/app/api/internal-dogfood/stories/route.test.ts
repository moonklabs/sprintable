import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getInternalDogfoodContext, createStory } = vi.hoisted(() => ({
  getInternalDogfoodContext: vi.fn(),
  createStory: vi.fn(),
}));

vi.mock('@/lib/internal-dogfood-server', () => ({
  getInternalDogfoodContext,
}));

vi.mock('@/services/internal-dogfood-sprintable', () => ({
  createInternalDogfoodStoryInSprintable: createStory,
}));

import { POST } from './route';

describe('POST /api/internal-dogfood/stories', () => {
  beforeEach(() => {
    getInternalDogfoodContext.mockReset();
    createStory.mockReset();
  });

  it('creates a story with the internal actor scope', async () => {
    getInternalDogfoodContext.mockResolvedValue({
      db: { tag: 'admin' },
      actor: { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
    });
    createStory.mockResolvedValue({ id: 'story-1' });

    const formData = new FormData();
    formData.set('title', 'Internal story');
    formData.set('description', 'story body');
    formData.set('status', 'backlog');
    formData.set('priority', 'high');
    formData.set('assignee_id', 'human-2');

    const response = await POST(new Request('http://localhost/api/internal-dogfood/stories', {
      method: 'POST',
      body: formData,
    })) as Response;

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('created_story_id=story-1');
    expect(createStory).toHaveBeenCalledWith(
      { tag: 'admin' },
      expect.objectContaining({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' }),
      expect.objectContaining({
        title: 'Internal story',
        assigneeId: 'human-2',
        priority: 'high',
      }),
    );
  });

  it('redirects back when the title is missing', async () => {
    getInternalDogfoodContext.mockResolvedValue({
      db: { tag: 'admin' },
      actor: { id: 'tm-1', org_id: 'org-1', project_id: 'project-1', name: 'Didi', project_name: 'Sprintable' },
    });

    const response = await POST(new Request('http://localhost/api/internal-dogfood/stories', {
      method: 'POST',
      body: new FormData(),
    })) as Response;

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('error=story_title_required');
    expect(createStory).not.toHaveBeenCalled();
  });
});
