import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkFeatureLimit } = vi.hoisted(() => ({
  checkFeatureLimit: vi.fn(),
}));

vi.mock('@/lib/check-feature', () => ({ checkFeatureLimit }));

import { requireAgentOrchestration } from './require-agent-orchestration';

describe('requireAgentOrchestration', () => {
  beforeEach(() => {
    checkFeatureLimit.mockReset();
  });

  it('returns null when the org plan allows agent orchestration', async () => {
    checkFeatureLimit.mockResolvedValue({ allowed: true });

    await expect(requireAgentOrchestration({} as never, 'org-1')).resolves.toBeNull();
  });

  it('returns a 403 upgrade payload when the feature is blocked', async () => {
    checkFeatureLimit.mockResolvedValue({
      allowed: false,
      reason: 'Upgrade to Team to use agent orchestration.',
    });

    const response = await requireAgentOrchestration({} as never, 'org-1');

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error: {
        code: 'UPGRADE_REQUIRED',
        message: 'Upgrade to Team to use agent orchestration.',
        details: {
          meterType: 'agent_orchestration',
        },
      },
    });
  });
});
