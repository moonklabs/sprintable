// @vitest-environment jsdom
//
// story #3962(E-UX-OVERHAUL·「오늘」 구현 3/N) — AC2 「플래그 off 404」.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { notFoundMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

vi.mock('@/components/today-v3/today-v3-screen', () => ({
  TodayV3Screen: () => 'today-v3-screen-stub',
}));

import TodayV3Page from './page';

describe('/today page — 플래그 게이트', () => {
  const original = process.env.TODAY_V3_ENABLED;

  afterEach(() => {
    process.env.TODAY_V3_ENABLED = original;
    notFoundMock.mockClear();
  });

  it('⭐플래그 off — notFound() 호출(404)', () => {
    delete process.env.TODAY_V3_ENABLED;
    expect(() => TodayV3Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('⭐플래그 on — notFound() 안 부르고 TodayV3Screen을 그린다', () => {
    process.env.TODAY_V3_ENABLED = 'true';
    const result = TodayV3Page();
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
  });
});
