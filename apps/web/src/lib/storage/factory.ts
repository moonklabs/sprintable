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

async function getSpAt(): Promise<string> {
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    return store.get('sp_at')?.value ?? '';
  } catch {
    return '';
  }
}

export async function createEpicRepository(db?: unknown): Promise<IEpicRepository> {
  if (isOssMode()) {
    const { SqliteEpicRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteEpicRepository(getDb());
  }
  const { ApiEpicRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiEpicRepository(await getSpAt());
}

export async function createStoryRepository(db?: unknown): Promise<IStoryRepository> {
  if (isOssMode()) {
    const { SqliteStoryRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteStoryRepository(getDb());
  }
  const { ApiStoryRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiStoryRepository(await getSpAt());
}

export async function createTaskRepository(db?: unknown): Promise<ITaskRepository> {
  if (isOssMode()) {
    const { SqliteTaskRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteTaskRepository(getDb());
  }
  const { ApiTaskRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiTaskRepository(await getSpAt());
}

export async function createMemoRepository(db?: unknown): Promise<IMemoRepository> {
  if (isOssMode()) {
    const { SqliteMemoRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteMemoRepository(getDb());
  }
  const { ApiMemoRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiMemoRepository(await getSpAt());
}

export async function createDocRepository(db?: unknown): Promise<IDocRepository> {
  if (isOssMode()) {
    const { SqliteDocRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteDocRepository(getDb());
  }
  const { ApiDocRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiDocRepository(await getSpAt());
}

export async function createProjectRepository(db?: unknown): Promise<IProjectRepository> {
  if (isOssMode()) {
    const { SqliteProjectRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteProjectRepository(getDb());
  }
  const { ApiProjectRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiProjectRepository(await getSpAt());
}

export async function createSprintRepository(db?: unknown): Promise<ISprintRepository> {
  if (isOssMode()) {
    const { SqliteSprintRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteSprintRepository(getDb());
  }
  const { ApiSprintRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiSprintRepository(await getSpAt());
}

export async function createNotificationRepository(db?: unknown): Promise<INotificationRepository> {
  if (isOssMode()) {
    const { SqliteNotificationRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteNotificationRepository(getDb());
  }
  const { ApiNotificationRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiNotificationRepository(await getSpAt());
}

export async function createTeamMemberRepository(db?: unknown): Promise<ITeamMemberRepository> {
  if (isOssMode()) {
    const { SqliteTeamMemberRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteTeamMemberRepository(getDb());
  }
  const { ApiTeamMemberRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiTeamMemberRepository(await getSpAt());
}

export async function createInboxItemRepository(db?: unknown): Promise<IInboxItemRepository> {
  if (isOssMode()) {
    const { SqliteInboxItemRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteInboxItemRepository(getDb());
  }
  const { ApiInboxItemRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiInboxItemRepository(await getSpAt());
}

// ============================================================================
// SaaS-only Repository Registry (DI pattern)
// ----------------------------------------------------------------------------
// OSS 코드는 절대 @moonklabs/storage-saas 를 직접 import 하지 않는다 (BYOA 원칙).
// 기본값은 Null stub. SaaS 결합 빌드에서는 부트스트랩(예: instrumentation hook)이
// registerSubscriptionRepository / registerAgentRunBillingRepository 로
// 실제 DB 구현체를 주입한다. OSS 단독 모드에서는 Null 그대로 작동.
// ============================================================================

type SubscriptionFactory = (db?: unknown) => Promise<ISubscriptionRepository>;
type AgentRunBillingFactory = (db?: unknown) => Promise<IAgentRunBillingRepository>;

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

export async function createSubscriptionRepository(db?: unknown): Promise<ISubscriptionRepository> {
  return _subscriptionFactory(db);
}

export async function createAgentRunBillingRepository(db?: unknown): Promise<IAgentRunBillingRepository> {
  return _agentRunBillingFactory(db);
}

export async function createAgentRunRepository(): Promise<IAgentRunRepository> {
  if (isOssMode()) {
    const { SqliteAgentRunRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteAgentRunRepository(getDb());
  }
  throw new Error('AgentRunRepository is only available in OSS mode');
}

export async function createAgentApiKeyRepository(): Promise<IAgentApiKeyRepository> {
  if (isOssMode()) {
    const { SqliteAgentApiKeyRepository, getDb } = await import('@sprintable/storage-sqlite');
    return new SqliteAgentApiKeyRepository(getDb());
  }
  throw new Error('AgentApiKeyRepository is only available in OSS mode');
}
