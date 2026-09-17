// @vitest-environment jsdom
//
// story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 플래그 off 404(「오늘」#3962 선례 동형)
// + PO CHANGES-8(2026-09-17): 「오늘」·「대화」 v3 플래그를 읽어 화면에 prop으로 내려준다
// (그 두 화면 자체 무접촉·env만 안다).
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFoundMock, screenMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  screenMock: vi.fn(() => 'connect-rules-v3-screen-stub'),
}));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

vi.mock('@/components/connect-rules-v3/connect-rules-v3-screen', () => ({
  ConnectRulesV3Screen: screenMock,
}));

import ConnectRulesV3Page from './page';

describe('/connect-rules page — 플래그 게이트', () => {
  const original = {
    connectRules: process.env.CONNECT_RULES_V3_ENABLED,
    today: process.env.TODAY_V3_ENABLED,
    chat: process.env.CHAT_V3_ENABLED,
  };

  afterEach(() => {
    process.env.CONNECT_RULES_V3_ENABLED = original.connectRules;
    process.env.TODAY_V3_ENABLED = original.today;
    process.env.CHAT_V3_ENABLED = original.chat;
    notFoundMock.mockClear();
    screenMock.mockClear();
  });

  it('⭐플래그 off — notFound() 호출(404)', () => {
    delete process.env.CONNECT_RULES_V3_ENABLED;
    expect(() => ConnectRulesV3Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('⭐플래그 on — notFound() 안 부르고 ConnectRulesV3Screen을 그린다', () => {
    process.env.CONNECT_RULES_V3_ENABLED = 'true';
    const result = ConnectRulesV3Page();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });

  it('⭐오늘·대화 v3 플래그 둘 다 off — 화면 element props에 false/false(교차 링크 404 방지)', () => {
    process.env.CONNECT_RULES_V3_ENABLED = 'true';
    delete process.env.TODAY_V3_ENABLED;
    delete process.env.CHAT_V3_ENABLED;
    const result = ConnectRulesV3Page() as unknown as { type: unknown; props: Record<string, unknown> };
    expect(result.type).toBe(screenMock);
    expect(result.props).toEqual({ todayV3Enabled: false, chatV3Enabled: false });
  });

  it('오늘·대화 v3 플래그 on — 화면 element props에 true/true', () => {
    process.env.CONNECT_RULES_V3_ENABLED = 'true';
    process.env.TODAY_V3_ENABLED = 'true';
    process.env.CHAT_V3_ENABLED = 'true';
    const result = ConnectRulesV3Page() as unknown as { type: unknown; props: Record<string, unknown> };
    expect(result.props).toEqual({ todayV3Enabled: true, chatV3Enabled: true });
  });
});
