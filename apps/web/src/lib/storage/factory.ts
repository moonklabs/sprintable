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
    const { cookies, headers } = await import('next/headers');
    // API key 요청: x-api-key 또는 Authorization: Bearer sk_live_* 헤더 우선
    const headerStore = await headers();
    const xApiKey = headerStore.get('x-api-key');
    if (xApiKey) return xApiKey;
    const authHeader = headerStore.get('authorization');
    if (authHeader?.startsWith('Bearer sk_live_')) return authHeader.slice(7);
    // OAuth 세션: sp_at 쿠키
    const store = await cookies();
    return store.get('sp_at')?.value ?? '';
  } catch {
    return '';
  }
}

export async function createEpicRepository(db?: unknown): Promise<IEpicRepository> {
  if (isOssMode()) {
    const { PgliteEpicRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteEpicRepository(await getDb());
  }
  const { ApiEpicRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiEpicRepository(await getSpAt());
}

export async function createStoryRepository(db?: unknown): Promise<IStoryRepository> {
  if (isOssMode()) {
    const { PgliteStoryRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteStoryRepository(await getDb());
  }
  const { ApiStoryRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiStoryRepository(await getSpAt());
}

export async function createTaskRepository(db?: unknown): Promise<ITaskRepository> {
  if (isOssMode()) {
    const { PgliteTaskRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteTaskRepository(await getDb());
  }
  const { ApiTaskRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiTaskRepository(await getSpAt());
}

export async function createMemoRepository(db?: unknown): Promise<IMemoRepository> {
  if (isOssMode()) {
    const { PgliteMemoRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteMemoRepository(await getDb());
  }
  const { ApiMemoRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiMemoRepository(await getSpAt());
}

export async function createDocRepository(db?: unknown): Promise<IDocRepository> {
  if (isOssMode()) {
    const { PgliteDocRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteDocRepository(await getDb());
  }
  const { ApiDocRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiDocRepository(await getSpAt());
}

export async function createProjectRepository(db?: unknown): Promise<IProjectRepository> {
  if (isOssMode()) {
    const { PgliteProjectRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteProjectRepository(await getDb());
  }
  const { ApiProjectRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiProjectRepository(await getSpAt());
}

export async function createSprintRepository(db?: unknown): Promise<ISprintRepository> {
  if (isOssMode()) {
    const { PgliteSprintRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteSprintRepository(await getDb());
  }
  const { ApiSprintRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiSprintRepository(await getSpAt());
}

export async function createNotificationRepository(db?: unknown): Promise<INotificationRepository> {
  if (isOssMode()) {
    const { PgliteNotificationRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteNotificationRepository(await getDb());
  }
  const { ApiNotificationRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiNotificationRepository(await getSpAt());
}

export async function createTeamMemberRepository(db?: unknown): Promise<ITeamMemberRepository> {
  if (isOssMode()) {
    const { PgliteTeamMemberRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteTeamMemberRepository(await getDb());
  }
  const { ApiTeamMemberRepository } = await import('@sprintable/storage-api');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ApiTeamMemberRepository(await getSpAt());
}

export async function createInboxItemRepository(db?: unknown): Promise<IInboxItemRepository> {
  if (isOssMode()) {
    const { PgliteInboxItemRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteInboxItemRepository(await getDb());
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
    const { PgliteAgentRunRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteAgentRunRepository(await getDb());
  }
  throw new Error('AgentRunRepository is only available in OSS mode');
}

export async function createAgentApiKeyRepository(): Promise<IAgentApiKeyRepository> {
  if (isOssMode()) {
    const { PgliteAgentApiKeyRepository, getDb } = await import('@sprintable/storage-pglite');
    return new PgliteAgentApiKeyRepository(await getDb());
  }
  throw new Error('AgentApiKeyRepository is only available in OSS mode');
}
