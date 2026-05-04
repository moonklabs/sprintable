import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate, mockList, mockProjectUpdate, isOssMode } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockList: vi.fn(),
  mockProjectUpdate: vi.fn(),
  isOssMode: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/storage/factory', () => ({
  isOssMode,
  createStoryRepository: vi.fn().mockResolvedValue({ create: mockCreate, list: mockList }),
  createProjectRepository: vi.fn().mockResolvedValue({ update: mockProjectUpdate }),
}));

vi.mock('@sprintable/storage-pglite', () => ({
  OSS_PROJECT_ID: 'oss-project',
  OSS_ORG_ID: 'oss-org',
}));

import { POST } from './route';

beforeEach(() => {
  mockCreate.mockReset();
  mockList.mockReset();
  mockProjectUpdate.mockReset();
  isOssMode.mockReturnValue(true);
});

describe('POST /api/oss/seed', () => {
  it('returns 403 in non-OSS mode', async () => {
    isOssMode.mockReturnValue(false);
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('NOT_AVAILABLE');
  });

  it('seeds 3 sample stories when database is empty', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'new-story' });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.seeded).toBe(true);
    expect(body.data.count).toBe(3);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('skips seeding when data already exists', async () => {
    mockList.mockResolvedValue([{ id: 'existing' }]);

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.seeded).toBe(false);
    expect(body.data.reason).toBe('already_has_data');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('seeds with correct project_id and org_id', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'story' });

    await POST();

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'oss-project', org_id: 'oss-org' }),
    );
  });

  it('proceeds even if project update fails', async () => {
    mockList.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ id: 'story' });
    mockProjectUpdate.mockRejectedValue(new Error('no project'));

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.seeded).toBe(true);
  });
});
