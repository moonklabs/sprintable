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
} from './types';

export type { ApiResponse, Story, Task, Memo, MemoSummary, MemoReply, MemoListFilters, CreateMemoReplyInput } from './types';

export interface SprintableClientOptions {
  /**
   * Base URL for Sprintable API
   * @default "https://sprintable.vercel.app"
   */
  baseURL?: string;

  /**
   * Additional axios configuration
   */
  axiosConfig?: AxiosRequestConfig;
}

export interface SprintableClient {
  /**
   * Axios instance with pre-configured authentication
   */
  axios: AxiosInstance;

  /**
   * API Key used for authentication
   */
  apiKey: string;

  /**
   * Story API methods
   */
  stories: {
    /**
     * Get a story by ID
     */
    get: (id: string) => Promise<Story>;
  };

  /**
   * Memo API methods
   */
  memos: {
    /**
     * Get a memo by ID
     */
    get: (id: string) => Promise<Memo>;

    /**
     * List memos with optional filters
     */
    list: (filters?: MemoListFilters) => Promise<MemoSummary[]>;

    /**
     * Reply to a memo
     */
    reply: (id: string, content: string | CreateMemoReplyInput) => Promise<MemoReply>;
  };
}

/**
 * Create a Sprintable API client with automatic Bearer token authentication
 *
 * @param apiKey - Sprintable API key (e.g., sk_live_...)
 * @param options - Client configuration options
 * @returns Configured Sprintable client
 *
 * @example
 * ```typescript
 * const client = createSprintableClient('sk_live_xxxxx');
 *
 * // Use the axios instance
 * const { data } = await client.axios.get('/api/memos');
 * console.log(data);
 * ```
 */
export function createSprintableClient(
  apiKey: string,
  options: SprintableClientOptions = {}
): SprintableClient {
  const {
    baseURL = 'https://sprintable.vercel.app',
    axiosConfig = {},
  } = options;

  const instance = axios.create({
    baseURL,
    ...axiosConfig,
    headers: {
      'Content-Type': 'application/json',
      ...axiosConfig.headers,
    },
  });

  // Add request interceptor to inject Bearer token
  instance.interceptors.request.use(
    (config) => {
      config.headers.Authorization = `Bearer ${apiKey}`;
      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  return {
    axios: instance,
    apiKey,

    stories: {
      async get(id: string): Promise<Story> {
        const response = await instance.get<ApiResponse<Story>>(`/api/stories/${id}`);
        return response.data.data;
      },
    },

    memos: {
      async get(id: string): Promise<Memo> {
        const response = await instance.get<ApiResponse<Memo>>(`/api/memos/${id}`);
        return response.data.data;
      },

      async list(filters: MemoListFilters = {}): Promise<MemoSummary[]> {
        const params = new URLSearchParams();
        if (filters.project_id) params.append('project_id', filters.project_id);
        if (filters.assigned_to) params.append('assigned_to', filters.assigned_to);
        if (filters.status) params.append('status', filters.status);
        if (filters.q) params.append('q', filters.q);
        if (filters.limit) params.append('limit', String(filters.limit));
        if (filters.cursor) params.append('cursor', filters.cursor);

        const response = await instance.get<ApiResponse<MemoSummary[]>>(`/api/memos?${params.toString()}`);
        return response.data.data;
      },

      async reply(id: string, content: string | CreateMemoReplyInput): Promise<MemoReply> {
        const payload = typeof content === 'string'
          ? { content }
          : content;

        const response = await instance.post<ApiResponse<MemoReply>>(
          `/api/memos/${id}/replies`,
          payload
        );
        return response.data.data;
      },
    },
  };
}
