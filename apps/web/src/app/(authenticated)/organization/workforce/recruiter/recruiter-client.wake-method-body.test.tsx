// @vitest-environment jsdom
//
// story #2434 — 유나 홀름 design:changes(2026-08-03, PR#2823): kitOrientingWakeBody_* 메시지가
// `<path>{path}</path>`(태그명 = ICU 인자명)이면 next-intl이 인자 값을 조용히 삼킨다 — 콘솔
// 에러도 없고 type-check도 안 잡는다. 소스 텍스트 매칭 가드(recruiter-client.test.tsx)는 이
// 문자열이 "존재하는지"만 보지 실제로 렌더됐을 때 값이 들어가는지는 안 본다 — 그래서 그 결함이
// 초록인 채로 통과했다. invite/page.test.tsx(#2084)와 같은 클래스의 위험: 실 DOM으로 고정한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { WakeMethodBody } from './recruiter-client';
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

describe('WakeMethodBody (story #2434) — path가 실제로 DOM에 렌더되는지', () => {
  it('ko channel-plugin: path 문자열이 DOM 텍스트로 실제 존재한다(빈 괄호 회귀가드)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="channel-plugin" path="packages/fakechat" />));
    });
    expect(container.textContent).toContain('packages/fakechat');
    expect(container.textContent).not.toContain('()'); // 빈 괄호로 퇴행하면 여기 걸린다
  });

  it('ko connector-host: path 문자열이 DOM 텍스트로 실제 존재한다', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="connector-host" path="connectors/codex-sprintable/" />));
    });
    expect(container.textContent).toContain('connectors/codex-sprintable/');
    expect(container.textContent).not.toContain('()');
  });

  it('en channel-plugin: path 문자열이 DOM 텍스트로 실제 존재한다', async () => {
    await act(async () => {
      root.render(wrap('en', <WakeMethodBody method="channel-plugin" path="packages/fakechat" />));
    });
    expect(container.textContent).toContain('packages/fakechat');
    expect(container.textContent).not.toContain('()');
  });

  it('en connector-host: path 문자열이 DOM 텍스트로 실제 존재한다', async () => {
    await act(async () => {
      root.render(wrap('en', <WakeMethodBody method="connector-host" path="connectors/codex-sprintable/" />));
    });
    expect(container.textContent).toContain('connectors/codex-sprintable/');
    expect(container.textContent).not.toContain('()');
  });

  it('path는 명령 대상이 아니라 이름으로 강등된다 — 링크 색·밑줄 클래스가 없다', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="connector-host" path="connectors/codex-sprintable/" />));
    });
    const code = container.querySelector('span.font-mono');
    expect(code?.textContent).toBe('connectors/codex-sprintable/');
    expect(code?.className).not.toMatch(/text-info|underline/);
  });

  it('unknown은 t.rich를 안 쓰고 plain 문구를 보여준다(path 태그 없음)', async () => {
    await act(async () => {
      root.render(wrap('ko', <WakeMethodBody method="unknown" path="" />));
    });
    expect(container.textContent?.length).toBeGreaterThan(0);
    expect(container.querySelector('span.font-mono')).toBeNull();
  });
});
