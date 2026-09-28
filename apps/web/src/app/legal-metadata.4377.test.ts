// story #4377 — 법무 문서 세 쪽의 탭 제목도 로케일(본문은 이미 getTranslations). 예전엔 `export const metadata = { title: 'Privacy Policy — Sprintable' }`
// 영어 고정이라 한국어 화면의 브라우저 탭에 영어가 떴다(4359 가드 객체 속성 축의 첫 기준선 셋 — 이 PR에서 0).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import koMessages from '../../messages/ko.json';

const { getTranslations } = vi.hoisted(() => ({ getTranslations: vi.fn() }));
vi.mock('next-intl/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next-intl/server')>()), getTranslations }));

beforeEach(() => {
  getTranslations.mockReset();
  getTranslations.mockImplementation(async (ns: string) => (key: string) => (koMessages as unknown as Record<string, Record<string, string>>)[ns]![key]);
});

describe('법무 문서 탭 제목 — 로케일(story #4377)', () => {
  it.each([
    ['privacy', () => import('./privacy/page'), '개인정보처리방침 — Sprintable'],
    ['terms', () => import('./terms/page'), '이용약관 — Sprintable'],
    ['refund-policy', () => import('./refund-policy/page'), '환불정책 — Sprintable'],
  ])('%s: generateMetadata가 legal 문구로 제목을 짓는다', async (_name, load, title) => {
    const mod = await load() as unknown as { generateMetadata: () => Promise<{ title: string }>; metadata?: unknown };
    expect(mod.metadata).toBeUndefined();
    await expect(mod.generateMetadata()).resolves.toEqual({ title });
    expect(getTranslations).toHaveBeenCalledWith('legal');
  });
});
