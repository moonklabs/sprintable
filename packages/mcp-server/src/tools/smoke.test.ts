import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAnalyticsTools } from './analytics';
import { registerCoreTools } from './core';
import { registerDocsTools } from './docs';
import { registerMeetingTools } from './meetings';
import { registerStoriesTools } from './stories';
import { registerTasksTools } from './tasks';
import { registerSprintsTools } from './sprints';
import { registerEpicsTools } from './epics';
import { registerMemosTools } from './memos';
import { registerNotificationsTools } from './notifications';
import { registerStandupsTools } from './standups';
import { registerAgentRunsTools } from './agent-runs';
import { configurePmApi } from '../pm-api';
import { registerRetroTools } from './retro';
import { registerRewardsTools } from './rewards';
import { registerStandupRetroTools } from './standup-retro';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

class FakeMcpServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
    return this;
  }
}

function parseResult(result: ToolResult) {
  const text = result.content[0]?.text ?? '';
  if (text.startsWith('Error: ')) {
    return { error: text.slice(7) };
  }
  return { data: JSON.parse(text) };
}

function createHarness() {
  const server = new FakeMcpServer();

  registerCoreTools(server as never);
  registerDocsTools(server as never);
  registerStoriesTools(server as never);
  registerAnalyticsTools(server as never);
  registerMeetingTools(server as never);
  registerRewardsTools(server as never);
  registerStandupRetroTools(server as never);
  registerRetroTools(server as never);
  registerTasksTools(server as never);
  registerSprintsTools(server as never);
  registerEpicsTools(server as never);
  registerMemosTools(server as never);
  registerNotificationsTools(server as never);
  registerStandupsTools(server as never);
  registerAgentRunsTools(server as never);

  return {
    invoke: async (toolName: string, args: Record<string, unknown>) => {
      const handler = server.handlers.get(toolName);
      if (!handler) throw new Error(`Tool not registered: ${toolName}`);
      return parseResult(await handler(args));
    },
  };
}

describe('core tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_team_members calls GET /api/members with project_id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/members?project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'member-alpha', name: 'Alpha Owner' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_team_members', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'member-alpha', name: 'Alpha Owner' }] });
  });

  it('list_team_members passes current_member_id as query param', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/members?current_member_id=member-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'member-alpha', name: 'Alpha Owner' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_team_members', { current_member_id: 'member-alpha' });
    expect(result).toEqual({ data: [{ id: 'member-alpha', name: 'Alpha Owner' }] });
  });

  it('list_team_members with no params calls GET /api/members (no query string)', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/members');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const result = await harness.invoke('list_team_members', {});
    expect(result).toEqual({ data: [] });
  });

  it('my_dashboard calls GET /api/dashboard with member_id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/dashboard?member_id=member-alpha');
      return new Response(JSON.stringify({ data: { my_stories: [], my_tasks: [], open_memos: [] } }), { status: 200 });
    });

    const result = await harness.invoke('my_dashboard', { member_id: 'member-alpha' });
    expect(result).toEqual({ data: { my_stories: [], my_tasks: [], open_memos: [] } });
  });

  it('my_dashboard includes project_id when provided', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/dashboard?member_id=member-alpha&project_id=project-alpha');
      return new Response(JSON.stringify({ data: { my_stories: [{ id: 'story-alpha' }], my_tasks: [], open_memos: [] } }), { status: 200 });
    });

    const result = await harness.invoke('my_dashboard', { member_id: 'member-alpha', project_id: 'project-alpha' });
    expect(result).toEqual({ data: { my_stories: [{ id: 'story-alpha' }], my_tasks: [], open_memos: [] } });
  });
});

describe('docs tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_docs calls GET /api/docs with view=tree', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/docs?project_id=project-alpha&view=tree');
      return new Response(JSON.stringify({ data: [{ id: 'doc-alpha', title: 'Intro' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_docs', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'doc-alpha', title: 'Intro' }] });
  });

  it('get_doc calls GET /api/docs with slug param', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/docs?project_id=project-alpha&slug=intro');
      return new Response(JSON.stringify({ data: { id: 'doc-alpha', slug: 'intro' } }), { status: 200 });
    });

    const result = await harness.invoke('get_doc', { project_id: 'project-alpha', slug: 'intro' });
    expect(result).toEqual({ data: { id: 'doc-alpha', slug: 'intro' } });
  });

  it('create_doc calls POST /api/docs', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/docs');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'New Doc', slug: 'new-doc' });
      return new Response(JSON.stringify({ data: { id: 'doc-new', title: 'New Doc' } }), { status: 200 });
    });

    const result = await harness.invoke('create_doc', { title: 'New Doc', slug: 'new-doc' });
    expect(result).toEqual({ data: { id: 'doc-new', title: 'New Doc' } });
  });

  it('update_doc calls PATCH /api/docs/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/docs/doc-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ content: 'Updated content' });
      return new Response(JSON.stringify({ data: { id: 'doc-alpha', content: 'Updated content' } }), { status: 200 });
    });

    const result = await harness.invoke('update_doc', { doc_id: 'doc-alpha', content: 'Updated content' });
    expect(result).toEqual({ data: { id: 'doc-alpha', content: 'Updated content' } });
  });

  it('delete_doc calls DELETE /api/docs/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/docs/doc-alpha');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('delete_doc', { doc_id: 'doc-alpha' });
    expect(result).toEqual({ data: { deleted: true } });
  });

  it('search_docs calls GET /api/docs with q param', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/docs?project_id=project-alpha&q=intro');
      return new Response(JSON.stringify({ data: [{ id: 'doc-alpha', title: 'Intro' }] }), { status: 200 });
    });

    const result = await harness.invoke('search_docs', { project_id: 'project-alpha', query: 'intro' });
    expect(result).toEqual({ data: [{ id: 'doc-alpha', title: 'Intro' }] });
  });

  it('propagates PmApiError message on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }));

    const result = await harness.invoke('get_doc', { project_id: 'project-alpha', slug: 'missing' });
    expect(result).toEqual({ error: 'Not found' });
  });
});

describe('stories tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_stories calls GET /api/stories with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/stories?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'story-alpha', title: 'Alpha story' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_stories', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'story-alpha', title: 'Alpha story' }] });
  });

  it('list_stories passes optional filters', async () => {
    stubFetch((url) => {
      expect(url).toContain('sprint_id=sprint-alpha');
      expect(url).toContain('status=in-progress');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await harness.invoke('list_stories', { project_id: 'project-alpha', sprint_id: 'sprint-alpha', status: 'in-progress' });
  });

  it('list_backlog calls GET /api/stories/backlog', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/stories/backlog?project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'story-alpha' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_backlog', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'story-alpha' }] });
  });

  it('add_story calls POST /api/stories', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ project_id: 'project-alpha', title: 'New Story' });
      return new Response(JSON.stringify({ data: { id: 'story-new', title: 'New Story' } }), { status: 200 });
    });

    const result = await harness.invoke('add_story', { project_id: 'project-alpha', title: 'New Story' });
    expect(result).toEqual({ data: { id: 'story-new', title: 'New Story' } });
  });

  it('update_story calls PATCH /api/stories/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'Updated title' });
      return new Response(JSON.stringify({ data: { id: 'story-alpha', title: 'Updated title' } }), { status: 200 });
    });

    const result = await harness.invoke('update_story', { story_id: 'story-alpha', title: 'Updated title' });
    expect(result).toEqual({ data: { id: 'story-alpha', title: 'Updated title' } });
  });

  it('delete_story calls DELETE /api/stories/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('delete_story', { story_id: 'story-alpha' });
    expect(result).toEqual({ data: { deleted: true } });
  });

  it('assign_story_to_sprint calls PATCH with sprint_id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ sprint_id: 'sprint-alpha' });
      return new Response(JSON.stringify({ data: { id: 'story-alpha', sprint_id: 'sprint-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('assign_story_to_sprint', { story_id: 'story-alpha', sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { id: 'story-alpha', sprint_id: 'sprint-alpha' } });
  });

  it('unassign_story_from_sprint calls PATCH with sprint_id null', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ sprint_id: null });
      return new Response(JSON.stringify({ data: { id: 'story-alpha', sprint_id: null } }), { status: 200 });
    });

    const result = await harness.invoke('unassign_story_from_sprint', { story_id: 'story-alpha' });
    expect(result).toEqual({ data: { id: 'story-alpha', sprint_id: null } });
  });

  it('update_story_status calls PATCH with status', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ status: 'in-progress' });
      return new Response(JSON.stringify({ data: { id: 'story-alpha', status: 'in-progress' } }), { status: 200 });
    });

    const result = await harness.invoke('update_story_status', { story_id: 'story-alpha', status: 'in-progress' });
    expect(result).toEqual({ data: { id: 'story-alpha', status: 'in-progress' } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }));

    const result = await harness.invoke('list_stories', { project_id: 'project-alpha' });
    expect(result).toEqual({ error: 'Unauthorized' });
  });
});

describe('tasks tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_tasks calls GET /api/tasks with optional filters', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/tasks?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('status=todo');
      return new Response(JSON.stringify({ data: [{ id: 'task-alpha', title: 'Alpha task' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_tasks', { project_id: 'project-alpha', status: 'todo' });
    expect(result).toEqual({ data: [{ id: 'task-alpha', title: 'Alpha task' }] });
  });

  it('list_my_tasks calls GET /api/tasks with assignee_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/tasks?');
      expect(url).toContain('assignee_id=member-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'task-alpha', assignee_id: 'member-alpha' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_my_tasks', { assignee_id: 'member-alpha' });
    expect(result).toEqual({ data: [{ id: 'task-alpha', assignee_id: 'member-alpha' }] });
  });

  it('get_task calls GET /api/tasks/:id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/tasks/task-alpha');
      return new Response(JSON.stringify({ data: { id: 'task-alpha', title: 'Alpha task' } }), { status: 200 });
    });

    const result = await harness.invoke('get_task', { task_id: 'task-alpha' });
    expect(result).toEqual({ data: { id: 'task-alpha', title: 'Alpha task' } });
  });

  it('add_task calls POST /api/tasks', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/tasks');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ story_id: 'story-alpha', title: 'New Task' });
      return new Response(JSON.stringify({ data: { id: 'task-new', title: 'New Task' } }), { status: 200 });
    });

    const result = await harness.invoke('add_task', { story_id: 'story-alpha', title: 'New Task' });
    expect(result).toEqual({ data: { id: 'task-new', title: 'New Task' } });
  });

  it('update_task calls PATCH /api/tasks/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/tasks/task-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'Updated task' });
      return new Response(JSON.stringify({ data: { id: 'task-alpha', title: 'Updated task' } }), { status: 200 });
    });

    const result = await harness.invoke('update_task', { task_id: 'task-alpha', title: 'Updated task' });
    expect(result).toEqual({ data: { id: 'task-alpha', title: 'Updated task' } });
  });

  it('update_task_status calls PATCH /api/tasks/:id with status only', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/tasks/task-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ status: 'done' });
      return new Response(JSON.stringify({ data: { id: 'task-alpha', status: 'done' } }), { status: 200 });
    });

    const result = await harness.invoke('update_task_status', { task_id: 'task-alpha', status: 'done' });
    expect(result).toEqual({ data: { id: 'task-alpha', status: 'done' } });
  });

  it('delete_task calls DELETE /api/tasks/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/tasks/task-alpha');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('delete_task', { task_id: 'task-alpha' });
    expect(result).toEqual({ data: { deleted: true } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Task not found' } }), { status: 404 }));

    const result = await harness.invoke('get_task', { task_id: 'task-missing' });
    expect(result).toEqual({ error: 'Task not found' });
  });
});

describe('sprints tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_sprints calls GET /api/sprints with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/sprints?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'sprint-alpha', title: 'Sprint Alpha' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_sprints', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'sprint-alpha', title: 'Sprint Alpha' }] });
  });

  it('list_sprints passes optional status filter', async () => {
    stubFetch((url) => {
      expect(url).toContain('status=active');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await harness.invoke('list_sprints', { project_id: 'project-alpha', status: 'active' });
  });

  it('activate_sprint calls POST /api/sprints/:id/activate', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/activate');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ data: { id: 'sprint-alpha', status: 'active' } }), { status: 200 });
    });

    const result = await harness.invoke('activate_sprint', { sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { id: 'sprint-alpha', status: 'active' } });
  });

  it('close_sprint calls POST /api/sprints/:id/close', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/close');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ data: { id: 'sprint-alpha', status: 'closed' } }), { status: 200 });
    });

    const result = await harness.invoke('close_sprint', { sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { id: 'sprint-alpha', status: 'closed' } });
  });

  it('get_velocity calls GET /api/sprints/:id/velocity', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/velocity');
      return new Response(JSON.stringify({ data: { velocity: 21, title: 'Sprint Alpha', status: 'closed' } }), { status: 200 });
    });

    const result = await harness.invoke('get_velocity', { sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { velocity: 21, title: 'Sprint Alpha', status: 'closed' } });
  });

  it('sprint_summary calls GET /api/sprints/:id/summary', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/summary');
      return new Response(JSON.stringify({ data: { done: { count: 3, points: 13 }, todo: { count: 1, points: 3 } } }), { status: 200 });
    });

    const result = await harness.invoke('sprint_summary', { sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { done: { count: 3, points: 13 }, todo: { count: 1, points: 3 } } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Sprint not found' } }), { status: 404 }));

    const result = await harness.invoke('get_velocity', { sprint_id: 'sprint-missing' });
    expect(result).toEqual({ error: 'Sprint not found' });
  });
});

describe('epics tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_epics calls GET /api/epics with project_id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/epics?project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'epic-alpha', title: 'Alpha Epic' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_epics', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'epic-alpha', title: 'Alpha Epic' }] });
  });

  it('add_epic calls POST /api/epics', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/epics');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ project_id: 'project-alpha', title: 'New Epic' });
      return new Response(JSON.stringify({ data: { id: 'epic-new', title: 'New Epic' } }), { status: 200 });
    });

    const result = await harness.invoke('add_epic', { project_id: 'project-alpha', title: 'New Epic' });
    expect(result).toEqual({ data: { id: 'epic-new', title: 'New Epic' } });
  });

  it('update_epic calls PATCH /api/epics/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/epics/epic-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'Updated Epic' });
      return new Response(JSON.stringify({ data: { id: 'epic-alpha', title: 'Updated Epic' } }), { status: 200 });
    });

    const result = await harness.invoke('update_epic', { epic_id: 'epic-alpha', title: 'Updated Epic' });
    expect(result).toEqual({ data: { id: 'epic-alpha', title: 'Updated Epic' } });
  });

  it('delete_epic calls DELETE /api/epics/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/epics/epic-alpha');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('delete_epic', { epic_id: 'epic-alpha' });
    expect(result).toEqual({ data: { deleted: true } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Epic not found' } }), { status: 404 }));

    const result = await harness.invoke('list_epics', { project_id: 'project-missing' });
    expect(result).toEqual({ error: 'Epic not found' });
  });
});

describe('memos tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_memos calls GET /api/memos with optional filters', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/memos');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('status=open');
      return new Response(JSON.stringify({ data: [{ id: 'memo-alpha', title: 'Alpha memo' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_memos', { project_id: 'project-alpha', status: 'open' });
    expect(result).toEqual({ data: [{ id: 'memo-alpha', title: 'Alpha memo' }] });
  });

  it('create_memo calls POST /api/memos', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/memos');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ content: 'Hello world' });
      return new Response(JSON.stringify({ data: { id: 'memo-new', content: 'Hello world' } }), { status: 200 });
    });

    const result = await harness.invoke('create_memo', { content: 'Hello world' });
    expect(result).toEqual({ data: { id: 'memo-new', content: 'Hello world' } });
  });

  it('send_memo calls POST /api/memos', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/memos');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ content: 'Kickoff memo', assigned_to: 'member-alpha' });
      return new Response(JSON.stringify({ data: { id: 'memo-sent', content: 'Kickoff memo' } }), { status: 200 });
    });

    const result = await harness.invoke('send_memo', { content: 'Kickoff memo', assigned_to: 'member-alpha' });
    expect(result).toEqual({ data: { id: 'memo-sent', content: 'Kickoff memo' } });
  });

  it('list_my_memos calls GET /api/memos with assigned_to filter', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/memos');
      expect(url).toContain('assigned_to=member-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'memo-alpha', assigned_to: 'member-alpha' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_my_memos', { assigned_to: 'member-alpha' });
    expect(result).toEqual({ data: [{ id: 'memo-alpha', assigned_to: 'member-alpha' }] });
  });

  it('read_memo calls GET /api/memos/:id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/memos/memo-alpha');
      return new Response(JSON.stringify({ data: { id: 'memo-alpha', content: 'Alpha content', replies: [] } }), { status: 200 });
    });

    const result = await harness.invoke('read_memo', { memo_id: 'memo-alpha' });
    expect(result).toEqual({ data: { id: 'memo-alpha', content: 'Alpha content', replies: [] } });
  });

  it('reply_memo calls POST /api/memos/:id/replies', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/memos/memo-alpha/replies');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ content: 'LGTM' });
      return new Response(JSON.stringify({ data: { id: 'reply-new', content: 'LGTM' } }), { status: 200 });
    });

    const result = await harness.invoke('reply_memo', { memo_id: 'memo-alpha', content: 'LGTM' });
    expect(result).toEqual({ data: { id: 'reply-new', content: 'LGTM' } });
  });

  it('resolve_memo calls PATCH /api/memos/:id/resolve', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/memos/memo-alpha/resolve');
      expect(init?.method).toBe('PATCH');
      return new Response(JSON.stringify({ data: { id: 'memo-alpha', status: 'resolved' } }), { status: 200 });
    });

    const result = await harness.invoke('resolve_memo', { memo_id: 'memo-alpha' });
    expect(result).toEqual({ data: { id: 'memo-alpha', status: 'resolved' } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Memo not found' } }), { status: 404 }));

    const result = await harness.invoke('read_memo', { memo_id: 'memo-missing' });
    expect(result).toEqual({ error: 'Memo not found' });
  });
});

describe('notifications tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('check_notifications calls GET /api/notifications', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/notifications?unread=true');
      return new Response(JSON.stringify({ data: [{ id: 'notif-1', is_read: false }] }), { status: 200 });
    });

    const result = await harness.invoke('check_notifications', { unread: true });
    expect(result).toEqual({ data: [{ id: 'notif-1', is_read: false }] });
  });

  it('mark_notification_read calls PATCH /api/notifications with id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/notifications');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ id: 'notif-1', is_read: true });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('mark_notification_read', { notification_id: 'notif-1' });
    expect(result).toEqual({ data: { ok: true } });
  });

  it('mark_all_notifications_read calls PATCH /api/notifications with markAllRead', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/notifications');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ markAllRead: true });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    const result = await harness.invoke('mark_all_notifications_read', {});
    expect(result).toEqual({ data: { ok: true } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }));

    const result = await harness.invoke('check_notifications', {});
    expect(result).toEqual({ error: 'Unauthorized' });
  });
});

describe('standups tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('get_standup calls GET /api/standup with project_id, member_id, date', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('member_id=member-alpha');
      expect(url).toContain('date=2026-04-06');
      return new Response(JSON.stringify({ data: { id: 'entry-1', author_id: 'member-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('get_standup', { project_id: 'project-alpha', member_id: 'member-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: { id: 'entry-1', author_id: 'member-alpha' } });
  });

  it('save_standup calls POST /api/standup with author_id and body fields', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/standup');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ author_id: 'member-alpha', date: '2026-04-06', done: 'Finished S7', plan: 'Start S8' });
      return new Response(JSON.stringify({ data: { id: 'entry-new', author_id: 'member-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('save_standup', { author_id: 'member-alpha', date: '2026-04-06', done: 'Finished S7', plan: 'Start S8' });
    expect(result).toEqual({ data: { id: 'entry-new', author_id: 'member-alpha' } });
  });

  it('list_standup_entries calls GET /api/standup with project_id and date', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('date=2026-04-06');
      return new Response(JSON.stringify({ data: [{ id: 'entry-1' }, { id: 'entry-2' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_standup_entries', { project_id: 'project-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: [{ id: 'entry-1' }, { id: 'entry-2' }] });
  });

  it('review_standup calls POST /api/standup/feedback', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/standup/feedback');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ standup_entry_id: 'entry-1', feedback_text: 'LGTM', review_type: 'approve' });
      return new Response(JSON.stringify({ data: { id: 'fb-new', review_type: 'approve' } }), { status: 201 });
    });

    const result = await harness.invoke('review_standup', { standup_entry_id: 'entry-1', feedback_text: 'LGTM', review_type: 'approve' });
    expect(result).toEqual({ data: { id: 'fb-new', review_type: 'approve' } });
  });

  it('get_standup_feedback calls GET /api/standup/feedback/:entry_id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/standup/feedback/entry-1');
      return new Response(JSON.stringify({ data: [{ id: 'fb-1', standup_entry_id: 'entry-1' }] }), { status: 200 });
    });

    const result = await harness.invoke('get_standup_feedback', { standup_entry_id: 'entry-1' });
    expect(result).toEqual({ data: [{ id: 'fb-1', standup_entry_id: 'entry-1' }] });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }));

    const result = await harness.invoke('get_standup', { project_id: 'project-alpha', member_id: 'member-missing', date: '2026-04-06' });
    expect(result).toEqual({ error: 'Not found' });
  });
});

describe('agent-runs tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('emit_event calls POST /api/agent-runs with agent_id and trigger', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/agent-runs');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ agent_id: 'agent-1', trigger: 'story_status_changed', status: 'completed' });
      return new Response(JSON.stringify({ data: { id: 'run-new', status: 'completed' } }), { status: 201 });
    });

    const result = await harness.invoke('emit_event', { agent_id: 'agent-1', trigger: 'story_status_changed', status: 'completed' });
    expect(result).toEqual({ data: { id: 'run-new', status: 'completed' } });
  });

  it('emit_event omits undefined optional fields from body', async () => {
    stubFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body).not.toHaveProperty('model');
      expect(body).not.toHaveProperty('story_id');
      return new Response(JSON.stringify({ data: { id: 'run-new' } }), { status: 201 });
    });

    await harness.invoke('emit_event', { agent_id: 'agent-1', trigger: 'test' });
  });

  it('update_run_status calls PATCH /api/agent-runs/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/agent-runs/run-1');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ status: 'completed', result_summary: 'All done' });
      return new Response(JSON.stringify({ data: { id: 'run-1', status: 'completed' } }), { status: 200 });
    });

    const result = await harness.invoke('update_run_status', { run_id: 'run-1', status: 'completed', result_summary: 'All done' });
    expect(result).toEqual({ data: { id: 'run-1', status: 'completed' } });
  });

  it('poll_events calls GET /api/agent-runs with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/agent-runs?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'run-1' }, { id: 'run-2' }] }), { status: 200 });
    });

    const result = await harness.invoke('poll_events', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'run-1' }, { id: 'run-2' }] });
  });

  it('poll_events passes optional limit param', async () => {
    stubFetch((url) => {
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await harness.invoke('poll_events', { project_id: 'project-alpha', limit: 5 });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 }));

    const result = await harness.invoke('emit_event', { agent_id: 'agent-1', trigger: 'test' });
    expect(result).toEqual({ error: 'Forbidden' });
  });
});

describe('analytics tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('get_project_overview calls GET /api/analytics/overview with project_id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/analytics/overview?project_id=project-alpha');
      return new Response(JSON.stringify({ data: { sprints: { total: 2, active: 1 }, epics: 3 } }), { status: 200 });
    });

    const result = await harness.invoke('get_project_overview', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: { sprints: { total: 2, active: 1 }, epics: 3 } });
  });

  it('get_member_workload calls GET /api/analytics/workload with project_id and member_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/analytics/workload?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('member_id=member-alpha');
      return new Response(JSON.stringify({ data: { stories: { total: 3, in_progress: 1, points: 8 }, tasks: { total: 2, in_progress: 1 } } }), { status: 200 });
    });

    const result = await harness.invoke('get_member_workload', { project_id: 'project-alpha', member_id: 'member-alpha' });
    expect(result).toEqual({ data: { stories: { total: 3, in_progress: 1, points: 8 }, tasks: { total: 2, in_progress: 1 } } });
  });

  it('search_stories calls GET /api/stories with q param', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/stories?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('q=alpha');
      return new Response(JSON.stringify({ data: [{ id: 'story-alpha', title: 'Alpha story' }] }), { status: 200 });
    });

    const result = await harness.invoke('search_stories', { project_id: 'project-alpha', query: 'alpha' });
    expect(result).toEqual({ data: [{ id: 'story-alpha', title: 'Alpha story' }] });
  });

  it('search_memos calls GET /api/memos with q param', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/memos?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('q=alpha');
      return new Response(JSON.stringify({ data: [{ id: 'memo-alpha', title: 'Alpha memo' }] }), { status: 200 });
    });

    const result = await harness.invoke('search_memos', { project_id: 'project-alpha', query: 'alpha' });
    expect(result).toEqual({ data: [{ id: 'memo-alpha', title: 'Alpha memo' }] });
  });

  it('get_blocked_stories calls GET /api/stories with status=in-review', async () => {
    stubFetch((url) => {
      expect(url).toContain('status=in-review');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    await harness.invoke('get_blocked_stories', { project_id: 'project-alpha' });
  });

  it('get_unassigned_stories calls GET /api/stories with unassigned=true', async () => {
    stubFetch((url) => {
      expect(url).toContain('unassigned=true');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'story-1', assignee_id: null }] }), { status: 200 });
    });

    const result = await harness.invoke('get_unassigned_stories', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'story-1', assignee_id: null }] });
  });

  it('get_overdue_tasks calls GET /api/tasks with status_ne=done', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/tasks?');
      expect(url).toContain('status_ne=done');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'task-alpha', status: 'todo' }] }), { status: 200 });
    });

    const result = await harness.invoke('get_overdue_tasks', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'task-alpha', status: 'todo' }] });
  });

  it('assign_story calls PATCH /api/stories/:id with assignee_id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/stories/story-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ assignee_id: 'member-alpha' });
      return new Response(JSON.stringify({ data: { id: 'story-alpha', assignee_id: 'member-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('assign_story', { story_id: 'story-alpha', assignee_id: 'member-alpha' });
    expect(result).toEqual({ data: { id: 'story-alpha', assignee_id: 'member-alpha' } });
  });

  it('get_epic_progress calls GET /api/analytics/epic-progress', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/analytics/epic-progress?');
      expect(url).toContain('epic_id=epic-alpha');
      return new Response(JSON.stringify({ data: { total_stories: 5, done_stories: 3, completion_pct: 60 } }), { status: 200 });
    });

    const result = await harness.invoke('get_epic_progress', { project_id: 'project-alpha', epic_id: 'epic-alpha' });
    expect(result).toEqual({ data: { total_stories: 5, done_stories: 3, completion_pct: 60 } });
  });

  it('get_project_health calls GET /api/analytics/health', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/analytics/health?project_id=project-alpha');
      return new Response(JSON.stringify({ data: { health: 'good', open_memos: 2, unassigned_stories: 1 } }), { status: 200 });
    });

    const result = await harness.invoke('get_project_health', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: { health: 'good', open_memos: 2, unassigned_stories: 1 } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404 }));

    const result = await harness.invoke('get_project_overview', { project_id: 'project-missing' });
    expect(result).toEqual({ error: 'Not found' });
  });
});

describe('retro tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('get_retro_session calls GET /api/retro/:sprint_id with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/retro/sprint-alpha?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: { id: 'retro-session-alpha', phase: 'collect' } }), { status: 200 });
    });

    const result = await harness.invoke('get_retro_session', { project_id: 'project-alpha', sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { id: 'retro-session-alpha', phase: 'collect' } });
  });

  it('change_retro_phase calls PATCH /api/retro/:sprint_id with phase', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('/api/retro/sprint-alpha?');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ phase: 'vote' });
      return new Response(JSON.stringify({ data: { id: 'retro-session-alpha', phase: 'vote' } }), { status: 200 });
    });

    const result = await harness.invoke('change_retro_phase', { project_id: 'project-alpha', sprint_id: 'sprint-alpha', phase: 'vote' });
    expect(result).toEqual({ data: { id: 'retro-session-alpha', phase: 'vote' } });
  });

  it('add_retro_item calls POST /api/retro/:sprint_id/items', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('/api/retro/sprint-alpha/items?');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ category: 'good', text: 'Great teamwork', author_id: 'member-alpha' });
      return new Response(JSON.stringify({ data: { id: 'item-new', category: 'good' } }), { status: 200 });
    });

    const result = await harness.invoke('add_retro_item', { project_id: 'project-alpha', sprint_id: 'sprint-alpha', category: 'good', text: 'Great teamwork', author_id: 'member-alpha' });
    expect(result).toEqual({ data: { id: 'item-new', category: 'good' } });
  });

  it('get_burndown calls GET /api/sprints/:id/burndown', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/burndown');
      return new Response(JSON.stringify({ data: { total_points: 13, done_points: 8, remaining_points: 5, completion_pct: 62 } }), { status: 200 });
    });

    const result = await harness.invoke('get_burndown', { sprint_id: 'sprint-alpha' });
    expect(result).toEqual({ data: { total_points: 13, done_points: 8, remaining_points: 5, completion_pct: 62 } });
  });

  it('kickoff_sprint calls POST /api/sprints/:id/kickoff', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/kickoff');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ data: { notified: 3 } }), { status: 200 });
    });

    const result = await harness.invoke('kickoff_sprint', { sprint_id: 'sprint-alpha', message: 'Let\'s go!' });
    expect(result).toEqual({ data: { notified: 3 } });
  });

  it('checkin_sprint calls GET /api/sprints/:id/checkin with date', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/sprints/sprint-alpha/checkin?date=2026-04-06');
      return new Response(JSON.stringify({ data: { total_stories: 5, done_points: 8, missing_standups: [] } }), { status: 200 });
    });

    const result = await harness.invoke('checkin_sprint', { sprint_id: 'sprint-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: { total_stories: 5, done_points: 8, missing_standups: [] } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Sprint not found' } }), { status: 404 }));

    const result = await harness.invoke('get_burndown', { sprint_id: 'sprint-missing' });
    expect(result).toEqual({ error: 'Sprint not found' });
  });
});

describe('standup-retro tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('get_standup_v2 calls GET /api/standup with member_id and date', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup?');
      expect(url).toContain('member_id=member-alpha');
      expect(url).toContain('date=2026-04-06');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: { id: 'standup-1', author_id: 'member-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('get_standup_v2', { project_id: 'project-alpha', member_id: 'member-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: { id: 'standup-1', author_id: 'member-alpha' } });
  });

  it('save_standup_v2 calls POST /api/standup with body fields', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/standup');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ author_id: 'member-alpha', date: '2026-04-06', done: 'Done', plan: 'Plan' });
      return new Response(JSON.stringify({ data: { id: 'standup-new', author_id: 'member-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('save_standup_v2', { author_id: 'member-alpha', date: '2026-04-06', done: 'Done', plan: 'Plan' });
    expect(result).toEqual({ data: { id: 'standup-new', author_id: 'member-alpha' } });
  });

  it('list_standup_entries_v2 calls GET /api/standup with date param', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup?');
      expect(url).toContain('date=2026-04-06');
      return new Response(JSON.stringify({ data: [{ id: 'standup-1' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_standup_entries_v2', { project_id: 'project-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: [{ id: 'standup-1' }] });
  });

  it('standup_missing calls GET /api/standup/missing with project_id and date', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup/missing?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('date=2026-04-06');
      return new Response(JSON.stringify({ data: { submitted_count: 1, missing: [] } }), { status: 200 });
    });

    const result = await harness.invoke('standup_missing', { project_id: 'project-alpha', date: '2026-04-06' });
    expect(result).toEqual({ data: { submitted_count: 1, missing: [] } });
  });

  it('standup_history calls GET /api/standup/history with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/standup/history?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'standup-1', date: '2026-04-06' }] }), { status: 200 });
    });

    const result = await harness.invoke('standup_history', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'standup-1', date: '2026-04-06' }] });
  });

  it('list_retro_sessions calls GET /api/retro-sessions with project_id', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/retro-sessions');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: [{ id: 'session-1', phase: 'collect' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_retro_sessions', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ id: 'session-1', phase: 'collect' }] });
  });

  it('create_retro_session calls POST /api/retro-sessions', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/retro-sessions');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ project_id: 'project-alpha', title: 'Sprint 1 Retro', created_by: 'member-alpha' });
      return new Response(JSON.stringify({ data: { id: 'session-new', title: 'Sprint 1 Retro' } }), { status: 200 });
    });

    const result = await harness.invoke('create_retro_session', { project_id: 'project-alpha', org_id: 'org-1', title: 'Sprint 1 Retro', created_by: 'member-alpha' });
    expect(result).toEqual({ data: { id: 'session-new', title: 'Sprint 1 Retro' } });
  });

  it('change_retro_phase_v2 calls PATCH /api/retro-sessions/:id with phase', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('/api/retro-sessions/session-1?');
      expect(url).toContain('project_id=project-alpha');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({ phase: 'group' });
      return new Response(JSON.stringify({ data: { id: 'session-1', phase: 'group' } }), { status: 200 });
    });

    const result = await harness.invoke('change_retro_phase_v2', { project_id: 'project-alpha', session_id: 'session-1', phase: 'group' });
    expect(result).toEqual({ data: { id: 'session-1', phase: 'group' } });
  });

  it('add_retro_item_v2 calls POST /api/retro-sessions/:id/items', async () => {
    stubFetch((url, init) => {
      expect(url).toContain('/api/retro-sessions/session-1/items?');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ category: 'good', text: 'Great work', author_id: 'member-alpha' });
      return new Response(JSON.stringify({ data: { id: 'item-new', category: 'good' } }), { status: 200 });
    });

    const result = await harness.invoke('add_retro_item_v2', { project_id: 'project-alpha', session_id: 'session-1', category: 'good', text: 'Great work', author_id: 'member-alpha' });
    expect(result).toEqual({ data: { id: 'item-new', category: 'good' } });
  });

  it('export_retro_v2 calls GET /api/retro-sessions/:id/export', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/retro-sessions/session-1/export?');
      expect(url).toContain('project_id=project-alpha');
      return new Response(JSON.stringify({ data: { markdown: '# Retro\n' } }), { status: 200 });
    });

    const result = await harness.invoke('export_retro_v2', { project_id: 'project-alpha', session_id: 'session-1' });
    expect(result).toEqual({ data: { markdown: '# Retro\n' } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Session not found' } }), { status: 404 }));

    const result = await harness.invoke('list_retro_sessions', { project_id: 'project-missing' });
    expect(result).toEqual({ error: 'Session not found' });
  });
});

describe('rewards tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('get_wallet calls GET /api/rewards with project_id, member_id, balance=true', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/rewards?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('member_id=member-alpha');
      expect(url).toContain('balance=true');
      return new Response(JSON.stringify({ data: { member_id: 'member-alpha', balance: 8, currency: 'TJSB' } }), { status: 200 });
    });

    const result = await harness.invoke('get_wallet', { project_id: 'project-alpha', member_id: 'member-alpha' });
    expect(result).toEqual({ data: { member_id: 'member-alpha', balance: 8, currency: 'TJSB' } });
  });

  it('give_reward calls POST /api/rewards with required fields', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/rewards');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ project_id: 'project-alpha', member_id: 'member-alpha', amount: 5, reason: 'Good PR', granted_by: 'member-beta' });
      return new Response(JSON.stringify({ data: { id: 'reward-new', amount: 5 } }), { status: 200 });
    });

    const result = await harness.invoke('give_reward', { project_id: 'project-alpha', member_id: 'member-alpha', amount: 5, reason: 'Good PR', granted_by: 'member-beta' });
    expect(result).toEqual({ data: { id: 'reward-new', amount: 5 } });
  });

  it('get_leaderboard_v2 calls GET /api/rewards with type=leaderboard', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/rewards?');
      expect(url).toContain('project_id=project-alpha');
      expect(url).toContain('type=leaderboard');
      return new Response(JSON.stringify({ data: [{ member_id: 'member-alpha', balance: 8 }] }), { status: 200 });
    });

    const result = await harness.invoke('get_leaderboard_v2', { project_id: 'project-alpha' });
    expect(result).toEqual({ data: [{ member_id: 'member-alpha', balance: 8 }] });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Forbidden' } }), { status: 403 }));

    const result = await harness.invoke('get_wallet', { project_id: 'project-alpha', member_id: 'member-alpha' });
    expect(result).toEqual({ error: 'Forbidden' });
  });
});

describe('meetings tools via pmApi', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeAll(() => {
    configurePmApi('http://test-pm-api', 'test-agent-key');
    harness = createHarness();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
  }

  it('list_meetings calls GET /api/meetings with optional filters', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/meetings');
      expect(url).toContain('meeting_type=standup');
      return new Response(JSON.stringify({ data: [{ id: 'meeting-alpha', title: 'Alpha Sync' }] }), { status: 200 });
    });

    const result = await harness.invoke('list_meetings', { meeting_type: 'standup' });
    expect(result).toEqual({ data: [{ id: 'meeting-alpha', title: 'Alpha Sync' }] });
  });

  it('get_meeting calls GET /api/meetings/:id', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://test-pm-api/api/meetings/meeting-alpha');
      return new Response(JSON.stringify({ data: { id: 'meeting-alpha', title: 'Alpha Sync' } }), { status: 200 });
    });

    const result = await harness.invoke('get_meeting', { meeting_id: 'meeting-alpha' });
    expect(result).toEqual({ data: { id: 'meeting-alpha', title: 'Alpha Sync' } });
  });

  it('create_meeting calls POST /api/meetings', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/meetings');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'Team Sync', meeting_type: 'general' });
      return new Response(JSON.stringify({ data: { id: 'meeting-new', title: 'Team Sync' } }), { status: 200 });
    });

    const result = await harness.invoke('create_meeting', { title: 'Team Sync', meeting_type: 'general' });
    expect(result).toEqual({ data: { id: 'meeting-new', title: 'Team Sync' } });
  });

  it('update_meeting calls PUT /api/meetings/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/meetings/meeting-alpha');
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({ title: 'Updated Sync' });
      return new Response(JSON.stringify({ data: { id: 'meeting-alpha', title: 'Updated Sync' } }), { status: 200 });
    });

    const result = await harness.invoke('update_meeting', { meeting_id: 'meeting-alpha', title: 'Updated Sync' });
    expect(result).toEqual({ data: { id: 'meeting-alpha', title: 'Updated Sync' } });
  });

  it('delete_meeting calls DELETE /api/meetings/:id', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/meetings/meeting-alpha');
      expect(init?.method).toBe('DELETE');
      return new Response(JSON.stringify({ data: { deleted: true, id: 'meeting-alpha' } }), { status: 200 });
    });

    const result = await harness.invoke('delete_meeting', { meeting_id: 'meeting-alpha' });
    expect(result).toEqual({ data: { deleted: true, id: 'meeting-alpha' } });
  });

  it('trigger_ai_summary calls POST /api/meetings/:id/summary', async () => {
    stubFetch((url, init) => {
      expect(url).toBe('http://test-pm-api/api/meetings/meeting-alpha/summary');
      expect(init?.method).toBe('POST');
      return new Response(JSON.stringify({ data: { meeting_id: 'meeting-alpha', summary: 'Team discussed blockers.' } }), { status: 200 });
    });

    const result = await harness.invoke('trigger_ai_summary', { meeting_id: 'meeting-alpha' });
    expect(result).toEqual({ data: { meeting_id: 'meeting-alpha', summary: 'Team discussed blockers.' } });
  });

  it('propagates PmApiError on non-2xx response', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: 'Meeting not found' } }), { status: 404 }));

    const result = await harness.invoke('get_meeting', { meeting_id: 'meeting-missing' });
    expect(result).toEqual({ error: 'Meeting not found' });
  });
});
