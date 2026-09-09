// @vitest-environment jsdom
//
// story #3715(2026-09-09, 유나 문구 確定) — loadGlanceData의 partialErrors.attention이
// 화면 소비처 0(「실패를 추적은 하되 아무도 안 보여주는」)이던 것을 받을 자리. attention
// fetch 실패 시 "손이 필요한 것 없음"(exceptionsEmpty)과 같은 자리·같은 클래스로
// exceptionsLoadError를 대신 그려 "실패"와 "진짜 비어 있음"을 가른다.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ExceptionStream } from './exception-stream';
import koMessages from '../../../messages/ko.json';

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

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('ExceptionStream — loadFailed이 exceptionsEmpty와 exceptionsLoadError를 가른다(story #3715)', () => {
  it('loadFailed=true면 "손이 필요한 것 없음"이 아니라 불러오기 실패를 말한다(회귀: 되돌리면 실패)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<ExceptionStream items={[]} loadFailed />));
    });
    expect(container.textContent).toBe(koMessages.glance.exceptionsLoadError);
    expect(container.textContent).not.toContain(koMessages.glance.exceptionsEmpty);
  });

  it('loadFailed=false(기본)·items=[]면 기존처럼 exceptionsEmpty만 뜬다(무회귀)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<ExceptionStream items={[]} />));
    });
    expect(container.textContent).toBe(koMessages.glance.exceptionsEmpty);
  });
});
