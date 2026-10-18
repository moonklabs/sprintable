// story 4725 decision 2 — the onboarding sits outside the dashboard shell, and a reclaimed account usually has no organization yet: the notice must be mounted here too.
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

vi.mock('@/lib/db/server', () => ({ getServerSession: async () => ({ user_id: 'u-1' }) }));
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

describe('story 4725 — the onboarding layout', () => {
  it('draws the reclaim notice above the page, and still draws the page', async () => {
    const child = <main data-testid="page" />;
    const tree = await OnboardingLayout({ children: child });
    const types = typesIn(tree);
    expect(types).toContain(ReclaimNoticeAlert);
    expect(types).toContain('main');
    expect(types.indexOf(ReclaimNoticeAlert)).toBeLessThan(types.indexOf('main'));   // above the form
  });
});
