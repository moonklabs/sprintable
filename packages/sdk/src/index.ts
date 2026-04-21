import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import type {
  ApiResponse,
  Story,
  Task,
  Memo,
  MemoSummary,
  MemoReply,
  MemoListFilters,
  CreateMemoReplyInput,
  CreateStoryInput,
  UpdateStoryInput,
  StoryListFilters,
  CreateTaskInput,
  UpdateTaskInput,
  TaskListFilters,
} from './types';

export type {
  ApiResponse,
  Story,
  Task,
  Memo,
  MemoSummary,
  MemoReply,
  MemoListFilters,
  CreateMemoReplyInput,
  CreateStoryInput,
  UpdateStoryInput,
  StoryListFilters,
  CreateTaskInput,
  UpdateTaskInput,
  TaskListFilters,
} from './types';

export interface SprintableClientOptions {
  /** Base URL for Sprintable API (e.g., "https://your-domain.example.com") */
  baseURL?: string;
  /** Additional axios configuration */
  axiosConfig?: AxiosRequestConfig;
}

export interface SprintableClient {
  /** Axios instance with pre-configured authentication */
  axios: AxiosInstance;
  /** API Key used for authentication */
  apiKey: string;

  stories: {
    /** Get a story by ID */
    get: (id: string) => Promise<Story>;
    /** List stories with optional filters */
    list: (filters?: StoryListFilters) => Promise<Story[]>;
    /** Create a new story */
    create: (input: CreateStoryInput) => Promise<Story>;
    /** Update a story */
    update: (id: string, input: UpdateStoryInput) => Promise<Story>;
  };

  tasks: {
    /** List tasks with optional filters */
    list: (filters?: TaskListFilters) => Promise<Task[]>;
    /** Create a new task */
    create: (input: CreateTaskInput) => Promise<Task>;
    /** Update a task */
    update: (id: string, input: UpdateTaskInput) => Promise<Task>;
  };

  memos: {
    /** Get a memo by ID */
    get: (id: string) => Promise<Memo>;
    /** List memos with optional filters */
    list: (filters?: MemoListFilters) => Promise<MemoSummary[]>;
    /** Reply to a memo */
    reply: (id: string, content: string | CreateMemoReplyInput) => Promise<MemoReply>;
  };
}

function buildParams(filters: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return `?${params.toString()}`;
}

/**
 * Create a Sprintable API client with automatic Bearer token authentication.
 *
 * @example
 * ```typescript
 * const client = createSprintableClient('sk_live_xxxxx', {
 *   baseURL: 'http://localhost:3108',
 * });
 *
 * // Create a story
 * const story = await client.stories.create({ title: 'SPR-1: Auth flow' });
 *
 * // Close it
 * await client.stories.update(story.id, { status: 'done' });
 * ```
 */
export function createSprintableClient(
  apiKey: string,
  options: SprintableClientOptions = {},
): SprintableClient {
  const { baseURL = '', axiosConfig = {} } = options;

  const instance = axios.create({
    baseURL,
    ...axiosConfig,
    headers: {
      'Content-Type': 'application/json',
      ...axiosConfig.headers,
    },
  });

  instance.interceptors.request.use(
    (config) => {
      config.headers.Authorization = `Bearer ${apiKey}`;
      return config;
    },
    (error) => Promise.reject(error),
  );

  return {
    axios: instance,
    apiKey,

    stories: {
      async get(id) {
        const res = await instance.get<ApiResponse<Story>>(`/api/stories/${id}`);
        return res.data.data;
      },

      async list(filters = {}) {
        const res = await instance.get<ApiResponse<Story[]>>(
          `/api/stories${buildParams(filters as Record<string, string | number | undefined>)}`,
        );
        return res.data.data;
      },

      async create(input) {
        const res = await instance.post<ApiResponse<Story>>('/api/stories', input);
        return res.data.data;
      },

      async update(id, input) {
        const res = await instance.patch<ApiResponse<Story>>(`/api/stories/${id}`, input);
        return res.data.data;
      },
    },

    tasks: {
      async list(filters = {}) {
        const res = await instance.get<ApiResponse<Task[]>>(
          `/api/tasks${buildParams(filters as Record<string, string | number | undefined>)}`,
        );
        return res.data.data;
      },

      async create(input) {
        const res = await instance.post<ApiResponse<Task>>('/api/tasks', input);
        return res.data.data;
      },

      async update(id, input) {
        const res = await instance.patch<ApiResponse<Task>>(`/api/tasks/${id}`, input);
        return res.data.data;
      },
    },

    memos: {
      async get(id) {
        const res = await instance.get<ApiResponse<Memo>>(`/api/memos/${id}`);
        return res.data.data;
      },

      async list(filters = {}) {
        const res = await instance.get<ApiResponse<MemoSummary[]>>(
          `/api/memos${buildParams(filters as Record<string, string | number | undefined>)}`,
        );
        return res.data.data;
      },

      async reply(id, content) {
        const payload = typeof content === 'string' ? { content } : content;
        const res = await instance.post<ApiResponse<MemoReply>>(
          `/api/memos/${id}/replies`,
          payload,
        );
        return res.data.data;
      },
    },
  };
}
