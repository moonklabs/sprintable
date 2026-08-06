// @vitest-environment jsdom
//
// story #2377 v1.3(2026-08-05, PO+유나 홀름) — kitOrientingConnectBodyCli가
// `<cmd>{command}</cmd>`(태그명=ICU 인자명 `cmd`가 아니라 `command`라 겹치지 않지만, 겹치는
// 실수가 재발하지 않는지는 실 렌더로만 확실히 잡힌다 — WakeMethodBody의 t.rich 태그명/인자명
// 충돌(#2434 REVERT급 회귀)과 같은 클래스라 소스매칭이 아니라 실 DOM으로 고정한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ConnectCliBody } from './recruiter-client';
import koMessages from '../../../../../../messages/ko.json';
import enMessages from '../../../../../../messages/en.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(locale: 'ko' | 'en', node: React.ReactNode) {
  const messages = locale === 'ko' ? koMessages : enMessages;
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Seoul">
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
});

describe('ConnectCliBody (story #2377 v1.3) — 런타임별 정확한 CLI 명령이 실제로 DOM에 렌더되는지', () => {
  it('ko hermes: 정확한 명령 문자열이 DOM 텍스트로 실제 존재한다(빈 괄호 회귀가드)', async () => {
    await act(async () => {
      root.render(wrap('ko', <ConnectCliBody command="hermes mcp add --url --auth" />));
    });
    expect(container.textContent).toContain('hermes mcp add --url --auth');
    expect(container.textContent).not.toContain('()');
  });

  it("ko openclaw: 정확한 명령 문자열이 실제 존재한다", async () => {
    await act(async () => {
      root.render(wrap('ko', <ConnectCliBody command="openclaw mcp set '<json>'" />));
    });
    expect(container.textContent).toContain("openclaw mcp set '<json>'");
  });

  it('en hermes: 정확한 명령 문자열이 실제 존재한다', async () => {
    await act(async () => {
      root.render(wrap('en', <ConnectCliBody command="hermes mcp add --url --auth" />));
    });
    expect(container.textContent).toContain('hermes mcp add --url --auth');
    expect(container.textContent).not.toContain('()');
  });

  it('명령은 mono 스타일로 렌더되고 링크색·밑줄이 없다(명령이지 클릭 대상이 아니다)', async () => {
    await act(async () => {
      root.render(wrap('ko', <ConnectCliBody command="hermes mcp add --url --auth" />));
    });
    const code = container.querySelector('span.font-mono');
    expect(code?.textContent).toBe('hermes mcp add --url --auth');
    expect(code?.className).not.toMatch(/text-info|underline/);
  });
});
