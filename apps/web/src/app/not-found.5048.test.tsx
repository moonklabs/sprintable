// story 5048 ⑤ — 루트 «없는 길»은 Next 기본(영어 «404 | This page could not be found.» · 돌아갈 길 없음)이 아니라 ds EmptyState + 홈으로(되돌리면 RED).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import RootNotFound from './not-found';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

async function render(locale: 'ko' | 'en') {
  await act(async () => {
    root.render(<NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul"><RootNotFound /></NextIntlClientProvider>);
  });
}

describe('루트 not-found(맨 위 없는 길)', () => {
  it('⭐app/not-found.tsx가 있다(없으면 Next 기본 영어 404가 뜬다)', () => {
    expect(existsSync(join(__dirname, 'not-found.tsx'))).toBe(true);
  });

  it.each([['ko', koMessages.notFound], ['en', enMessages.notFound]] as const)('⭐%s: ds EmptyState · 알림 역할 없음 · 제목 · 설명 · 홈(/)으로 가는 ds 단추 링크 · Next 기본 문구 0', async (locale, m) => {
    await render(locale);
    expect(container.querySelector('[data-slot="ds-empty-state"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull(); // «없음»은 에러가 아니라 알림으로 읽히지 않는다
    expect(container.querySelector('[data-slot="ds-error-state"]')).toBeNull();
    expect(container.textContent).toContain(m.title);
    expect(container.textContent).toContain(m.description);
    expect(container.textContent).not.toContain('This page could not be found');
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/');
    expect(a.textContent).toBe(m.cta);
    expect(a.getAttribute('data-slot')).toBe('ds-button');
  });

  it('⭐단추 글은 «홈으로» · «Back to home» — 옛 «대시보드로» · «Back to dashboard»(그 이름의 화면은 없다 · 길은 `/` = 홈)가 아니다', () => {
    expect(koMessages.notFound.cta).toBe('홈으로');
    expect(enMessages.notFound.cta).toBe('Back to home');
  });
});
