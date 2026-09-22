// @vitest-environment node
//
// story #4017 CHANGES 2(그라운딩에서 놓쳤던 자리, 페드루 PO 지적 2026-09-17 15:31Z) —
// /dashboard(폐합) 리다이렉트가 플래그 OFF/ON 양쪽에서 맞는 주소로 가는지 고정.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

beforeEach(() => {
  redirectMock.mockClear();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DashboardRedirect', () => {
  it('⭐CHAT_V3_ENABLED 미설정(OFF) — /chats로 리다이렉트(기존, 바이트 동일)', async () => {
    const { default: Page } = await import('./page');
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/chats');
  });

  it('⭐CHAT_V3_ENABLED=true — /chat으로 리다이렉트', async () => {
    vi.stubEnv('CHAT_V3_ENABLED', 'true');
    const { default: Page } = await import('./page');
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/chat');
  });
});
