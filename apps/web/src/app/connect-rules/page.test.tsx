// @vitest-environment jsdom
//
// story #3982(E-UX-OVERHAUL·「연결·규칙」 구현 2/N) — 플래그 off 404(「오늘」#3962 선례 동형).
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

vi.mock('@/components/connect-rules-v3/connect-rules-v3-screen', () => ({
  ConnectRulesV3Screen: () => 'connect-rules-v3-screen-stub',
}));

import ConnectRulesV3Page from './page';

describe('/connect-rules page — 플래그 게이트', () => {
  const original = process.env.CONNECT_RULES_V3_ENABLED;

  afterEach(() => {
    process.env.CONNECT_RULES_V3_ENABLED = original;
    notFoundMock.mockClear();
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
});
