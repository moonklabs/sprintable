// @vitest-environment jsdom
//
// story #2843/#2844 — goal 신값(unmeasured·unmeasurable)이 이전엔 이 타입에 없어 fallback
// (statusPending="측정 대기")으로 오표시됐다. "닫혔는데 미판정"과 "아직 안 닫힌 대기"는
// 다른 사실이라 no-fiction상 구분돼야 한다 — 그 회귀를 잠근다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OutcomeStatusBadge } from './outcome-status-badge';

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
});

describe('OutcomeStatusBadge', () => {
  it('unmeasured는 "측정 대기"(pending)로 폴백하지 않고 전용 라벨을 쓴다', async () => {
    await act(async () => { root.render(wrap(<OutcomeStatusBadge status="unmeasured" />)); });
    expect(container.textContent).toBe(koMessages.outcomeLoop.statusUnmeasured);
    expect(container.textContent).not.toBe(koMessages.outcomeLoop.statusPending);
  });

  it('unmeasurable도 전용 라벨을 쓴다', async () => {
    await act(async () => { root.render(wrap(<OutcomeStatusBadge status="unmeasurable" />)); });
    expect(container.textContent).toBe(koMessages.outcomeLoop.statusUnmeasurable);
  });

  // soul-lock 동형 — miss·unmeasured·unmeasurable 전부 destructive(빨강) 금지.
  it('unmeasured·unmeasurable 배지에 destructive 클래스가 없다', async () => {
    await act(async () => { root.render(wrap(<OutcomeStatusBadge status="unmeasured" />)); });
    expect(container.querySelector('span')?.className).not.toMatch(/bg-destructive/);
    await act(async () => { root.render(wrap(<OutcomeStatusBadge status="unmeasurable" />)); });
    expect(container.querySelector('span')?.className).not.toMatch(/bg-destructive/);
  });

  it('n_a는 여전히 아무것도 렌더하지 않는다(무회귀)', async () => {
    await act(async () => { root.render(wrap(<OutcomeStatusBadge status="n_a" />)); });
    expect(container.innerHTML).toBe('');
  });
});
