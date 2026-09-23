// @vitest-environment jsdom
//
// story #4221(유나 design) — docs·storage·settings 오류 화면의 보조 버튼은 «로그인으로 이동»이라 적혀 있었지만 실제로는 그 화면
// (/docs · /storage · /dashboard/settings)으로 갔다. 라벨 = 실제 목적지(유나 확정 문안) — 렌더해서 라벨·href 쌍을 단언한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import DocsError from '@/app/(authenticated)/[ws]/[proj]/docs/error';
import StorageError from '@/app/(authenticated)/[ws]/[proj]/storage/error';
import SettingsError from '@/app/dashboard/settings/error';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

type ErrorPage = ComponentType<{ error: Error; reset: () => void }>;
const CASES: ReadonlyArray<[string, ErrorPage, string, string, string]> = [
  ['문서', DocsError, '/docs', '문서로 돌아가기', 'Back to docs'],
  ['스토리지', StorageError, '/storage', '스토리지로 돌아가기', 'Back to storage'],
  ['설정', SettingsError, '/dashboard/settings', '설정으로 돌아가기', 'Back to settings'],
];

async function link(Page: ErrorPage, locale: 'ko' | 'en') {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <Page error={new Error('x')} reset={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  const links = [...container.querySelectorAll('a')];
  expect(links).toHaveLength(1);
  return { href: links[0]!.getAttribute('href'), label: links[0]!.textContent };
}

describe('오류 화면 보조 버튼 — 라벨 = 실제 목적지(story #4221)', () => {
  it.each(CASES)('%s 오류 화면', async (_n, Page, href, ko, en) => {
    expect(await link(Page, 'ko')).toEqual({ href, label: ko });
    expect(await link(Page, 'en')).toEqual({ href, label: en });
    expect(container.textContent).not.toContain(enMessages.common.goToLogin);
  });
});
