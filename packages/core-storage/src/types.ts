export interface PaginationOptions {
  limit?: number;
  cursor?: string | null;
}

export type StorageAdapter = 'supabase' | 'sqlite';
