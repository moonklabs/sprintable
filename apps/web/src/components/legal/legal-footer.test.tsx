// @vitest-environment jsdom
//
// story #2741 — 앱 內 사업자정보·법적 문서 확인 경로. 「표시를 테스트」한다: 6종 값이 실제
// 렌더 결과에 오르고, 3종 법적 문서 링크가 기존 legal 라우트로 걸리며, raw i18n 키가 새지
// 않는지 검증(훅 배선이 아니라 화면에 나온 텍스트/href로 확인).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BUSINESS_INFO } from '@/lib/legal/business-info';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/',
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.resetModules();
});

async function mount(node: React.ReactNode) {
  await act(async () => { root.render(wrap(node)); });
}

describe('LegalFooter (story #2741)', () => {
  // 카디르군 QA(#3203) — 기대값을 SSOT에서 뽑으면 «값이 틀려도 GREEN»인 동어반복이라(ceo
  // 변조 뮤테이션으로 실증), 기대값을 story #2740 정본의 «하드코딩 리터럴»로 박는다 — SSOT가
  // 정본과 어긋나면 실제로 빨개지는 «틀릴 수 있는 표본».
  const EXPECTED_BUSINESS_INFO = [
    '주식회사 뭉클랩',
    '윤도선',
    '488-88-02579',
    '경기도 고양시 일산동구 무궁화로 20-38, 5층 502호',
    '070-8098-5775',
    '제2023-고양일산동-1337호',
  ] as const;

  it('SSOT 값이 #2740 정본과 글자 단위로 일치한다 (변조 검출 · 하드코딩 대조)', () => {
    expect(BUSINESS_INFO.companyName).toBe('주식회사 뭉클랩');
    expect(BUSINESS_INFO.ceo).toBe('윤도선');
    expect(BUSINESS_INFO.registrationNumber).toBe('488-88-02579');
    expect(BUSINESS_INFO.address).toBe('경기도 고양시 일산동구 무궁화로 20-38, 5층 502호');
    expect(BUSINESS_INFO.phone).toBe('070-8098-5775');
    expect(BUSINESS_INFO.mailOrderNumber).toBe('제2023-고양일산동-1337호');
  });

  it('사업자정보 6종 값이 모두 화면에 렌더된다 (정본 리터럴 대조)', async () => {
    const { LegalFooter } = await import('./legal-footer');
    await mount(<LegalFooter />);
    const text = container.textContent ?? '';
    for (const value of EXPECTED_BUSINESS_INFO) {
      expect(text).toContain(value);
    }
  });

  it('법적 문서 3종 링크가 기존 legal 라우트로 걸린다', async () => {
    const { LegalFooter } = await import('./legal-footer');
    await mount(<LegalFooter />);
    const anchors = Array.from(container.querySelectorAll('a'));
    const hrefs = anchors.map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/privacy');
    expect(hrefs).toContain('/refund-policy');
    const labels = anchors.map((a) => a.textContent);
    expect(labels).toContain('이용약관');
    expect(labels).toContain('개인정보처리방침');
    expect(labels).toContain('환불정책');
  });

  it('raw i18n 키가 노출되지 않는다', async () => {
    const { LegalFooter } = await import('./legal-footer');
    await mount(<LegalFooter />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(
      /legal\.|policiesHeading|businessInfoHeading|ceoLabel|registrationLabel|mailOrderLabel|termsOfService|privacyPolicy|refundPolicy/,
    );
  });
});
