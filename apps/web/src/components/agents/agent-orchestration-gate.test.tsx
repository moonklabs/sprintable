import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const {
  createSupabaseServerClient,
  checkFeatureLimit,
  getTranslations,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  checkFeatureLimit: vi.fn(),
  getTranslations: vi.fn(),
}));

vi.mock('next-intl/server', () => ({ getTranslations }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/check-feature', () => ({ checkFeatureLimit }));

import { AgentOrchestrationGate } from './agent-orchestration-gate';

describe('AgentOrchestrationGate', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    checkFeatureLimit.mockReset();
    getTranslations.mockReset();

    createSupabaseServerClient.mockResolvedValue({});
    getTranslations.mockResolvedValue((key: string) => ({
      orchestrationGateTitle: 'Agent orchestration requires Team',
      orchestrationGateDescription: 'Upgrade to unlock deployments, personas, and workflow routing.',
      orchestrationGateAction: 'View plans & upgrade',
    }[key] ?? key));
  });

  it('renders children when agent orchestration is allowed', async () => {
    checkFeatureLimit.mockResolvedValue({ allowed: true });

    const element = await AgentOrchestrationGate({
      orgId: 'org-1',
      children: <div>dashboard</div>,
    });

    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('dashboard');
    expect(markup).not.toContain('/pricing');
  });

  it('renders an upgrade path when agent orchestration is blocked', async () => {
    checkFeatureLimit.mockResolvedValue({ allowed: false, upgradeRequired: true });

    const element = await AgentOrchestrationGate({
      orgId: 'org-1',
      children: <div>dashboard</div>,
    });

    const markup = renderToStaticMarkup(element);
    expect(markup).toContain('Agent orchestration requires Team');
    expect(markup).toContain('View plans &amp; upgrade');
    expect(markup).toContain('/pricing');
    expect(markup).not.toContain('dashboard');
  });
});
