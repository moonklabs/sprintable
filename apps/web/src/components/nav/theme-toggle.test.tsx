// @vitest-environment jsdom
//
// story #4183(산티아고 prod 에스컬레이션 f4b1cb03) — 테마 토글 버튼의 aria-label이
// light/dark/system 영문 값 그대로 스크린리더에 읽히던 결함. 로케일 문자열(settings.theme*
// 기존 키 재사용)로 읽히는지 두 로케일에서 고정한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import { ThemeToggle } from './theme-toggle';

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
});

async function labelsFor(locale: 'ko' | 'en', messages: typeof koMessages) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
        <ThemeToggle />
      </NextIntlClientProvider>,
    );
  });
  return [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
}

describe('ThemeToggle aria-label (story #4183)', () => {
  it('KO 로케일에서 한국어로 읽힌다', async () => {
    expect(await labelsFor('ko', koMessages)).toEqual(['라이트 모드', '다크 모드', '시스템 설정']);
  });

  it('EN 로케일에서 영어로 읽힌다', async () => {
    expect(await labelsFor('en', enMessages as typeof koMessages)).toEqual(['Light mode', 'Dark mode', 'System setting']);
  });

  // 유나 design 확認(2026-09-23) — «시스템 설정» 버튼이 단독으로 읽히면 설정 화면 이동처럼
  // 들린다. 그룹 라벨(«테마»)이 붙어 있어야 «테마 › 시스템 설정»으로 뜻이 선다.
  it('세 버튼이 «테마» 그룹 라벨 아래 묶인다', async () => {
    await labelsFor('ko', koMessages);
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute('aria-label')).toBe('테마');
    expect(group?.querySelectorAll('button')).toHaveLength(3);
  });
});
