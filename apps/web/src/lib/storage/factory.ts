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
  IAgentRunRepository,
  IAgentApiKeyRepository,
  IInboxItemRepository,
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

export async function createInboxItemRepository(supabase?: unknown): Promise<IInboxItemRepository> {
  if (isOssMode()) {
    const { SqliteInboxItemRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteInboxItemRepository(getDb());
  }
  const { SupabaseInboxItemRepository } = await import('@sprintable/storage-supabase');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SupabaseInboxItemRepository(supabase as any);
}

// ============================================================================
// SaaS-only Repository Registry (DI pattern)
// ----------------------------------------------------------------------------
// OSS 코드는 절대 @moonklabs/storage-saas 를 직접 import 하지 않는다 (BYOA 원칙).
// 기본값은 Null stub. SaaS 결합 빌드에서는 부트스트랩(예: instrumentation hook)이
// registerSubscriptionRepository / registerAgentRunBillingRepository 로
// 실제 Supabase 구현체를 주입한다. OSS 단독 모드에서는 Null 그대로 작동.
// ============================================================================

type SubscriptionFactory = (supabase?: unknown) => Promise<ISubscriptionRepository>;
type AgentRunBillingFactory = (supabase?: unknown) => Promise<IAgentRunBillingRepository>;

let _subscriptionFactory: SubscriptionFactory = async () => {
  const { NullSubscriptionRepository } = await import('@sprintable/core-storage');
  return new NullSubscriptionRepository();
};

let _agentRunBillingFactory: AgentRunBillingFactory = async () => {
  const { NullAgentRunBillingRepository } = await import('@sprintable/core-storage');
  return new NullAgentRunBillingRepository();
};

export function registerSubscriptionRepository(factory: SubscriptionFactory): void {
  _subscriptionFactory = factory;
}

export function registerAgentRunBillingRepository(factory: AgentRunBillingFactory): void {
  _agentRunBillingFactory = factory;
}

export async function createSubscriptionRepository(supabase?: unknown): Promise<ISubscriptionRepository> {
  return _subscriptionFactory(supabase);
}

export async function createAgentRunBillingRepository(supabase?: unknown): Promise<IAgentRunBillingRepository> {
  return _agentRunBillingFactory(supabase);
}

export async function createAgentRunRepository(): Promise<IAgentRunRepository> {
  const { SqliteAgentRunRepository, getDb } = await import('@sprintable/storage-sqlite');
  return new SqliteAgentRunRepository(getDb());
}

export async function createAgentApiKeyRepository(): Promise<IAgentApiKeyRepository> {
  const { SqliteAgentApiKeyRepository, getDb } = await import('@sprintable/storage-sqlite');
  return new SqliteAgentApiKeyRepository(getDb());
}
