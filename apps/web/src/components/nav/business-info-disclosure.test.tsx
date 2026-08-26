// @vitest-environment jsdom
//
// story #2870 — GNB footer 「사업자 정보」 접이식 토글. 「표시를 테스트」한다: default 접힘
// 상태에서 패널이 렌더되지 않고, 클릭하면 사업자정보 6종+법적 문서 3링크가 실제로
// 나타나는지 화면 결과로 확인한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { BUSINESS_INFO } from '@/lib/legal/business-info';
import { BusinessInfoDisclosure } from './business-info-disclosure';

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

describe('BusinessInfoDisclosure (story #2870)', () => {
  it('default 접힘 — 패널이 렌더되지 않고 토글은 aria-expanded=false다', async () => {
    await mount(<BusinessInfoDisclosure />);
    const toggle = container.querySelector('button') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain(BUSINESS_INFO.registrationNumber);
  });

  it('클릭하면 사업자정보 6종과 법적 문서 3링크가 렌더된다', async () => {
    await mount(<BusinessInfoDisclosure />);
    const toggle = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { toggle.click(); });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const text = container.textContent ?? '';
    expect(text).toContain(BUSINESS_INFO.companyName);
    expect(text).toContain(BUSINESS_INFO.ceo);
    expect(text).toContain(BUSINESS_INFO.registrationNumber);
    expect(text).toContain(BUSINESS_INFO.mailOrderNumber);
    expect(text).toContain(BUSINESS_INFO.address);
    expect(text).toContain(BUSINESS_INFO.phone);

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/terms');
    expect(hrefs).toContain('/privacy');
    expect(hrefs).toContain('/refund-policy');
  });

  it('다시 클릭하면 접힌다', async () => {
    await mount(<BusinessInfoDisclosure />);
    const toggle = container.querySelector('button') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain(BUSINESS_INFO.registrationNumber);
  });
});
