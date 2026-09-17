// @vitest-environment node
//
// story #3743(UI 재설계 ③, 페드루 PO 決) — 이 화면은 organization/channels로 흡수됐다.
// 옛 ConnectorCard 전수 테스트(missingRequiredFieldNames 등)는 새 자리
// agent-setup-section.test.tsx로 옮겼다(그 파일이 같은 계약을 pin) — 여기는 리다이렉트
// 한 줄만 확인.
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

describe('OrganizationConnectorsRedirectPage', () => {
  it('⭐CONNECT_RULES_V3_ENABLED 미설정(OFF) — /organization/channels로 리다이렉트(기존, 바이트 동일)', async () => {
    const { default: Page } = await import('./page');
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/organization/channels');
  });

  // story #4017(PO 확定 2026-09-17) AC3 — 플래그 ON 도착 주소 단언.
  it('⭐CONNECT_RULES_V3_ENABLED=true — /connect-rules로 리다이렉트', async () => {
    vi.stubEnv('CONNECT_RULES_V3_ENABLED', 'true');
    const { default: Page } = await import('./page');
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/connect-rules');
  });
});
