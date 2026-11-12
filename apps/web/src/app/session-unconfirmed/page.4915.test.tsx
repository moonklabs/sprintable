// story 4915 (PR 2) — the page the proxy rewrites an unconfirmed page load to: the existing «다시 시도» screen and nothing else (no session read, no data, no children).
import { describe, expect, it, vi } from 'vitest';

const FailureScreen = vi.hoisted(() => function AccountContextFailureStandIn() { return null; });
vi.mock('@/components/auth/account-context-failure', () => ({ AccountContextFailure: FailureScreen }));

describe('/session-unconfirmed page', () => {
  it('is exactly the retry screen — no session lookup, no extra children', async () => {
    const { default: Page } = await import('./page');
    const el = Page() as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(FailureScreen);
    expect(Object.keys(el.props)).toEqual([]);
  });
});
