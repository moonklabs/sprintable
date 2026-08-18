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
  it('사업자정보 6종 값이 모두 화면에 렌더된다', async () => {
    const { LegalFooter } = await import('./legal-footer');
    await mount(<LegalFooter />);
    const text = container.textContent ?? '';
    for (const value of Object.values(BUSINESS_INFO)) {
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
