// @vitest-environment jsdom
//
// story #4406 — iPhone(앱 웹뷰 · Safari)은 글자가 16px 미만인 입력칸에 초점이 가면 화면을 확대한다. 로그인 이메일 · 비밀번호 칸이
// text-sm(14px)이라 누를 때마다 약 1.14배 확대됐다. 모바일 폭에서는 16px 이상 · 데스크톱(lg 이상)은 예전 14px 그대로인지를
// 실제 Tailwind 컴파일 CSS의 캐스케이드로 잰다(jsdom getComputedStyle은 var()를 못 풀어 크기 판정에 못 쓴다 — story #4316 도우미).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { loadTailwindCascade, mediaMatchesWidth } from '@/components/docs/lib/tailwind-cascade.test-helper';

vi.mock('@/lib/db/client', () => ({ loginWithPassword: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

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

function toPx(value: string): number {
  const m = /^([\d.]+)(px|rem)$/.exec(value.trim());
  if (!m) throw new Error(`font-size를 px로 못 바꿈: «${value}»`);
  return m[2] === 'rem' ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
}

async function loginInputs(): Promise<HTMLInputElement[]> {
  const { default: LoginPage } = await import('./page');
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <LoginPage />
      </NextIntlClientProvider>,
    );
  });
  const inputs = [...container.querySelectorAll<HTMLInputElement>('input')].filter((el) => !['checkbox', 'hidden'].includes(el.type));
  expect(inputs.map((el) => el.type)).toEqual(['email', 'password']);
  return inputs;
}

describe('로그인 입력칸 글자 크기(story #4406)', () => {
  it('⭐모바일 폭(390px) — 이메일 · 비밀번호 칸이 16px 이상(iOS 초점 확대 없음)', async () => {
    const inputs = await loginInputs();
    const cascade = await loadTailwindCascade(container, { viewportWidth: 390 });
    expect(cascade.unparsable()).toEqual([]);
    for (const el of inputs) expect(toPx(cascade.computed(el, 'font-size', 'light')), el.type).toBeGreaterThanOrEqual(16);
  });

  it('데스크톱 폭(1280px) — 예전 크기(14px) 그대로', async () => {
    const inputs = await loginInputs();
    const cascade = await loadTailwindCascade(container, { viewportWidth: 1280 });
    for (const el of inputs) expect(toPx(cascade.computed(el, 'font-size', 'light')), el.type).toBe(14);
  });
});

describe('mediaMatchesWidth — 폭 조건 판정(도우미 셀프테스트)', () => {
  it('Tailwind 4 변형 · min/max-width · and · 폭 아닌 조건', () => {
    expect(mediaMatchesWidth('(width >= 64rem)', 390)).toBe(false);
    expect(mediaMatchesWidth('(width >= 64rem)', 1024)).toBe(true);
    expect(mediaMatchesWidth('(max-width: 1023px)', 390)).toBe(true);
    expect(mediaMatchesWidth('(max-width: 1023px)', 1280)).toBe(false);
    expect(mediaMatchesWidth('(min-width: 768px) and (max-width: 1023px)', 800)).toBe(true);
    expect(mediaMatchesWidth('(prefers-reduced-motion: reduce)', 390)).toBeNull();
  });
});
