// story 4725 decision 2 — the onboarding sits outside the dashboard shell, and a reclaimed account usually has no organization yet: the notice must be mounted here too.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const h = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.session }));
vi.mock('@/components/auth/tab-owner-gate', () => ({ TabOwnerGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/auth/reclaim-notice', () => ({ ReclaimNoticeAlert: () => null }));

import OnboardingLayout from './layout';
import { ReclaimNoticeAlert } from '@/components/auth/reclaim-notice';

function typesIn(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) { node.forEach((n) => typesIn(n, out)); return out; }
  if (node && typeof node === 'object' && 'type' in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    out.push(el.type);
    typesIn(el.props?.children, out);
  }
  return out;
}

beforeEach(() => { h.session.mockReset().mockResolvedValue({ user_id: 'u-1' }); });

describe('story 4725 — the onboarding layout', () => {
  it('draws the reclaim notice above the page, and still draws the page', async () => {
    const child = <main data-testid="page" />;
    const tree = await OnboardingLayout({ children: child });
    const types = typesIn(tree);
    expect(types).toContain(ReclaimNoticeAlert);
    expect(types).toContain('main');
    expect(types.indexOf(ReclaimNoticeAlert)).toBeLessThan(types.indexOf('main'));   // above the form
  });

  it('without a session (an anonymous visit — the page decides about login itself) the notice is not mounted: it would read /api/auth/me and a 401 there ends the app\'s session', async () => {
    h.session.mockResolvedValue(null);
    expect(typesIn(await OnboardingLayout({ children: <main /> }))).not.toContain(ReclaimNoticeAlert);
    h.session.mockRejectedValue(new Error('no cookie jar'));
    const types = typesIn(await OnboardingLayout({ children: <main /> }));
    expect(types).not.toContain(ReclaimNoticeAlert);
    expect(types).toContain('main');
  });
});
