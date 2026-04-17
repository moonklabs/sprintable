import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSprintableClient } from './index';
import type { Story, Memo, MemoSummary, MemoReply } from './types';

describe('SDK Typed Methods', () => {
  const TEST_API_KEY = 'sk_live_test123';
  const BASE_URL = 'https://test.sprintable.app';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('stories.get()', () => {
    it('fetches a story by ID', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockStory: Story = {
        id: 'story-1',
        org_id: 'org-1',
        title: 'Test Story',
        status: 'in-progress',
        project_id: 'project-1',
        assignee_id: 'user-1',
        priority: 'high',
        meeting_id: null,
        created_at: '2026-04-14T00:00:00Z',
        updated_at: '2026-04-14T00:00:00Z',
        tasks: [],
      };

      const mockAdapter = vi.fn(() =>
        Promise.resolve({
          data: { data: mockStory, error: null, meta: null },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {},
        })
      );

      client.axios.defaults.adapter = mockAdapter as any;

      const story = await client.stories.get('story-1');

      expect(mockAdapter).toHaveBeenCalled();
      expect(story).toEqual(mockStory);
    });
  });

  describe('memos.get()', () => {
    it('fetches a memo by ID', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockMemo: Memo = {
        id: 'memo-1',
        title: 'Test Memo',
        content: 'Test Memo Content',
        status: 'open',
        memo_type: 'memo',
        project_id: 'project-1',
        created_by: 'user-1',
        assigned_to: null,
        created_at: '2026-04-14T00:00:00Z',
        updated_at: '2026-04-14T00:00:00Z',
        replies: [],
        reply_count: 0,
        latest_reply_at: null,
        project_name: 'Project 1',
        timeline: [{ label: 'created', at: '2026-04-14T00:00:00Z', by: 'user-1' }],
        linked_docs: [],
        readers: [],
        supersedes_chain: [],
      };

      const mockAdapter = vi.fn(() =>
        Promise.resolve({
          data: { data: mockMemo, error: null, meta: null },
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {},
        })
      );

      client.axios.defaults.adapter = mockAdapter as any;

      const memo = await client.memos.get('memo-1');

      expect(mockAdapter).toHaveBeenCalled();
      expect(memo).toEqual(mockMemo);
    });
  });

  describe('memos.list()', () => {
    it('fetches memos with filters', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockMemos: MemoSummary[] = [
        {
          id: 'memo-1',
          project_id: 'project-1',
          title: 'Memo 1',
          content: 'Content 1',
          status: 'open',
          memo_type: 'memo',
          created_by: 'user-1',
          assigned_to: null,
          created_at: '2026-04-14T00:00:00Z',
          reply_count: 0,
          latest_reply_at: null,
          project_name: 'Project 1',
          readers: [],
        },
        {
          id: 'memo-2',
          project_id: 'project-1',
          title: null,
          content: 'Content 2',
          status: 'resolved',
          memo_type: 'memo',
          created_by: 'user-1',
          assigned_to: null,
          created_at: '2026-04-14T01:00:00Z',
          reply_count: 0,
          latest_reply_at: null,
          project_name: 'Project 1',
          readers: [],
        },
      ];

      const mockAdapter = vi.fn((config) => {
        expect(config.url).toContain('/api/memos?');
        expect(config.url).toContain('status=open');
        expect(config.url).toContain('limit=10');

        return Promise.resolve({
          data: { data: mockMemos, error: null, meta: null },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        });
      });

      client.axios.defaults.adapter = mockAdapter as any;

      const memos = await client.memos.list({ status: 'open', limit: 10 });

      expect(mockAdapter).toHaveBeenCalled();
      expect(memos).toEqual(mockMemos);
    });

    it('fetches all memos without filters', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockMemos: MemoSummary[] = [];

      const mockAdapter = vi.fn((config) => {
        expect(config.url).toBe('/api/memos?');

        return Promise.resolve({
          data: { data: mockMemos, error: null, meta: null },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        });
      });

      client.axios.defaults.adapter = mockAdapter as any;

      const memos = await client.memos.list();

      expect(mockAdapter).toHaveBeenCalled();
      expect(memos).toEqual(mockMemos);
    });
  });

  describe('memos.reply()', () => {
    it('creates a reply with string content', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockReply: MemoReply = {
        id: 'reply-1',
        memo_id: 'memo-1',
        content: 'Test reply',
        created_by: 'user-1',
        created_at: '2026-04-14T00:00:00Z',
      };

      const mockAdapter = vi.fn((config) => {
        expect(config.url).toBe('/api/memos/memo-1/replies');
        expect(config.data).toBe('{"content":"Test reply"}');

        return Promise.resolve({
          data: { data: mockReply, error: null, meta: null },
          status: 201,
          statusText: 'Created',
          headers: {},
          config,
        });
      });

      client.axios.defaults.adapter = mockAdapter as any;

      const reply = await client.memos.reply('memo-1', 'Test reply');

      expect(mockAdapter).toHaveBeenCalled();
      expect(reply).toEqual(mockReply);
    });

    it('creates a reply with CreateMemoReplyInput object', async () => {
      const client = createSprintableClient(TEST_API_KEY, { baseURL: BASE_URL });

      const mockReply: MemoReply = {
        id: 'reply-2',
        memo_id: 'memo-1',
        content: 'Looks good',
        created_by: 'user-1',
        created_at: '2026-04-14T00:00:00Z',
      };

      const mockAdapter = vi.fn((config) => {
        expect(config.url).toBe('/api/memos/memo-1/replies');
        expect(config.data).toBe('{"content":"Looks good"}');

        return Promise.resolve({
          data: { data: mockReply, error: null, meta: null },
          status: 201,
          statusText: 'Created',
          headers: {},
          config,
        });
      });

      client.axios.defaults.adapter = mockAdapter as any;

      const reply = await client.memos.reply('memo-1', {
        content: 'Looks good',
      });

      expect(mockAdapter).toHaveBeenCalled();
      expect(reply).toEqual(mockReply);
    });
  });
});
