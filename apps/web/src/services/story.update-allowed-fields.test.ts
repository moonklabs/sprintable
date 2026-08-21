import { describe, it, expect, vi } from 'vitest';
import { StoryService } from './story';
import type { IStoryRepository, Story } from '@sprintable/core-storage';

// story #2868/#2874 자매(2026-08-21, 페드루 라이브 프로브 실측) — StoryService.update()의
// ALLOWED_FIELDS allowlist가 expected_updated_at/force_overwrite를 몰라 zod(updateStorySchema,
// 같은 사고로 이미 수정)를 통과해도 여기서 다시 조용히 스트립됐다(요청 파이프라인 두 층에
// 중복 존재하던 같은 결함 클래스). repo.update()에 실제로 실리는 값을 값으로 잰다 —
// "성공했다"만 보면 이 클래스의 결함을 못 잡는다(2863/2868/2874 공통 교훈).

function _story(overrides: Partial<Story> = {}): Story {
  return {
    id: 's1', org_id: 'org1', project_id: 'proj1', title: 't', status: 'backlog',
    priority: 'medium', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Story;
}

describe('StoryService.update — expected_updated_at/force_overwrite 생존(회귀 — 2868/2874)', () => {
  it('expected_updated_at이 repo.update()에 실제로 전달된다', async () => {
    const existing = _story();
    const repo: Partial<IStoryRepository> = {
      getById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue(existing),
    };
    const service = new StoryService(repo as IStoryRepository);

    await service.update('s1', {
      description: 'updated', expected_updated_at: '2026-01-01T00:00:00Z',
    } as any);

    expect(repo.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ expected_updated_at: '2026-01-01T00:00:00Z' }),
    );
  });

  it('force_overwrite이 repo.update()에 실제로 전달된다', async () => {
    const existing = _story();
    const repo: Partial<IStoryRepository> = {
      getById: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue(existing),
    };
    const service = new StoryService(repo as IStoryRepository);

    await service.update('s1', { description: 'updated', force_overwrite: true } as any);

    expect(repo.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ force_overwrite: true }),
    );
  });
});
