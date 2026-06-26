import type {
  IEpicRepository,
  IStoryRepository,
  ITaskRepository,
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
  IHypothesisRepository,
  IStorageService,
} from '@sprintable/core-storage';
import { STORAGE_PROVIDER } from './config';

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

export async function createEpicRepository(): Promise<IEpicRepository> {
  const { ApiEpicRepository } = await import('@sprintable/storage-api');
  return new ApiEpicRepository(await getSpAt());
}

export async function createStoryRepository(): Promise<IStoryRepository> {
  const { ApiStoryRepository } = await import('@sprintable/storage-api');
  return new ApiStoryRepository(await getSpAt());
}

export async function createHypothesisRepository(): Promise<IHypothesisRepository> {
  const { ApiHypothesisRepository } = await import('@sprintable/storage-api');
  return new ApiHypothesisRepository(await getSpAt());
}

export async function createTaskRepository(): Promise<ITaskRepository> {
  const { ApiTaskRepository } = await import('@sprintable/storage-api');
  return new ApiTaskRepository(await getSpAt());
}

export async function createDocRepository(): Promise<IDocRepository> {
  const { ApiDocRepository } = await import('@sprintable/storage-api');
  return new ApiDocRepository(await getSpAt());
}

export async function createProjectRepository(): Promise<IProjectRepository> {
  const { ApiProjectRepository } = await import('@sprintable/storage-api');
  return new ApiProjectRepository(await getSpAt());
}

export async function createSprintRepository(): Promise<ISprintRepository> {
  const { ApiSprintRepository } = await import('@sprintable/storage-api');
  return new ApiSprintRepository(await getSpAt());
}

export async function createNotificationRepository(): Promise<INotificationRepository> {
  const { ApiNotificationRepository } = await import('@sprintable/storage-api');
  return new ApiNotificationRepository(await getSpAt());
}

export async function createTeamMemberRepository(): Promise<ITeamMemberRepository> {
  const { ApiTeamMemberRepository } = await import('@sprintable/storage-api');
  return new ApiTeamMemberRepository(await getSpAt());
}

export async function createInboxItemRepository(): Promise<IInboxItemRepository> {
  const { ApiInboxItemRepository } = await import('@sprintable/storage-api');
  return new ApiInboxItemRepository(await getSpAt());
}

// ============================================================================
// SaaS-only Repository Registry (DI pattern)
// ----------------------------------------------------------------------------
// 기본값은 Null stub. SaaS 결합 빌드에서는 부트스트랩(예: instrumentation hook)이
// registerSubscriptionRepository / registerAgentRunBillingRepository 로
// 실제 DB 구현체를 주입한다.
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

// ============================================================================
// Blob Storage Service (E-STORAGE-SSOT S1)
// ----------------------------------------------------------------------------
// 셀렉션은 `STORAGE_PROVIDER` env 주도(OSS 기본 local). provider SDK 는 dynamic import 로
// 분리 → 선택된 provider 만 번들/로드(local/GCS 유저는 @aws-sdk 비용 0).
//
// ⚠️ 기존 GCS 배포(dev/prod)는 ee unbuilt OSS 이미지로 단독 구동 → `registerStorageService()`
// 가 불리지 않으므로 **반드시 `STORAGE_PROVIDER=gcs` env 명시**(미설정 default local → 첨부
// ephemeral 디스크 적재·GCS 무회귀 위반). register seam 은 미래 ee 용으로만 유지(단독 셀렉터 금지).
// ============================================================================

type StorageServiceFactory = () => Promise<IStorageService>;
let _storageServiceFactory: StorageServiceFactory | null = null;

export function registerStorageService(factory: StorageServiceFactory): void {
  _storageServiceFactory = factory;
}

export async function createStorageService(): Promise<IStorageService> {
  if (_storageServiceFactory) return _storageServiceFactory();
  switch (STORAGE_PROVIDER) {
    case 'gcs': {
      const { GcsStorageService } = await import('./providers/gcs');
      return new GcsStorageService();
    }
    case 's3':
    case 'minio': {
      const { S3StorageService } = await import('./providers/s3');
      return new S3StorageService();
    }
    case 'local':
    default: {
      const { LocalDiskStorageService } = await import('./providers/local');
      return new LocalDiskStorageService();
    }
  }
}

export async function createAgentRunRepository(): Promise<IAgentRunRepository> {
  throw new Error('AgentRunRepository is not available in SaaS mode');
}

export async function createAgentApiKeyRepository(): Promise<IAgentApiKeyRepository> {
  throw new Error('AgentApiKeyRepository is not available in SaaS mode');
}
