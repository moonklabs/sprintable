// @vitest-environment node
//
// story #3743(UI 재설계 ③, 페드루 PO 決) — 이 화면은 organization/channels로 흡수됐다.
// 옛 ConnectorCard 전수 테스트(missingRequiredFieldNames 등)는 새 자리
// agent-setup-section.test.tsx로 옮겼다(그 파일이 같은 계약을 pin) — 여기는 리다이렉트
// 한 줄만 확인.
import { describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({ redirectMock: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

describe('OrganizationConnectorsRedirectPage', () => {
  it('⭐/organization/channels로 리다이렉트한다(라우트는 남고 화면만 흡수)', async () => {
    redirectMock.mockClear();
    const { default: Page } = await import('./page');
    Page();
    expect(redirectMock).toHaveBeenCalledWith('/organization/channels');
  });
});
