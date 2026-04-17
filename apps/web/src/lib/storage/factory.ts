import type {
  IEpicRepository,
  IStoryRepository,
  ITaskRepository,
  IMemoRepository,
  IDocRepository,
  IProjectRepository,
  ISprintRepository,
  INotificationRepository,
  ITeamMemberRepository,
  ISubscriptionRepository,
  IAgentRunBillingRepository,
} from '@sprintable/core-storage';

export function isOssMode(): boolean {
  return process.env['OSS_MODE'] === 'true';
}

export async function createEpicRepository(supabase?: unknown): Promise<IEpicRepository> {
  if (isOssMode()) {
    const { SqliteEpicRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteEpicRepository(getDb());
  }
  const { SupabaseEpicRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseEpicRepository(supabase as any);
}

export async function createStoryRepository(supabase?: unknown): Promise<IStoryRepository> {
  if (isOssMode()) {
    const { SqliteStoryRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteStoryRepository(getDb());
  }
  const { SupabaseStoryRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseStoryRepository(supabase as any);
}

export async function createTaskRepository(supabase?: unknown): Promise<ITaskRepository> {
  if (isOssMode()) {
    const { SqliteTaskRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteTaskRepository(getDb());
  }
  const { SupabaseTaskRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseTaskRepository(supabase as any);
}

export async function createMemoRepository(supabase?: unknown): Promise<IMemoRepository> {
  if (isOssMode()) {
    const { SqliteMemoRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteMemoRepository(getDb());
  }
  const { SupabaseMemoRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseMemoRepository(supabase as any);
}

export async function createDocRepository(supabase?: unknown): Promise<IDocRepository> {
  if (isOssMode()) {
    const { SqliteDocRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteDocRepository(getDb());
  }
  const { SupabaseDocRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseDocRepository(supabase as any);
}

export async function createProjectRepository(supabase?: unknown): Promise<IProjectRepository> {
  if (isOssMode()) {
    const { SqliteProjectRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteProjectRepository(getDb());
  }
  const { SupabaseProjectRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseProjectRepository(supabase as any);
}

export async function createSprintRepository(supabase?: unknown): Promise<ISprintRepository> {
  if (isOssMode()) {
    const { SqliteSprintRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteSprintRepository(getDb());
  }
  const { SupabaseSprintRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseSprintRepository(supabase as any);
}

export async function createNotificationRepository(supabase?: unknown): Promise<INotificationRepository> {
  if (isOssMode()) {
    const { SqliteNotificationRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteNotificationRepository(getDb());
  }
  const { SupabaseNotificationRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseNotificationRepository(supabase as any);
}

export async function createTeamMemberRepository(supabase?: unknown): Promise<ITeamMemberRepository> {
  if (isOssMode()) {
    const { SqliteTeamMemberRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteTeamMemberRepository(getDb());
  }
  const { SupabaseTeamMemberRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseTeamMemberRepository(supabase as any);
}

export async function createSubscriptionRepository(_supabase?: unknown): Promise<ISubscriptionRepository> {
  if (isOssMode()) {
    const { NullSubscriptionRepository } = await import('@sprintable/core-storage');
    return new NullSubscriptionRepository();
  }
  // SaaS 모드: Phase C에서 sprintable-saas에 구현 예정. 현재 호출 시 명시적 에러.
  const { NotImplementedError } = await import('@sprintable/core-storage');
  throw new NotImplementedError('SubscriptionRepository — implement in sprintable-saas (Phase C)');
}

export async function createAgentRunBillingRepository(_supabase?: unknown): Promise<IAgentRunBillingRepository> {
  if (isOssMode()) {
    const { NullAgentRunBillingRepository } = await import('@sprintable/core-storage');
    return new NullAgentRunBillingRepository();
  }
  // SaaS 모드: Phase C에서 sprintable-saas에 구현 예정. 현재 호출 시 명시적 에러.
  const { NotImplementedError } = await import('@sprintable/core-storage');
  throw new NotImplementedError('AgentRunBillingRepository — implement in sprintable-saas (Phase C)');
}
