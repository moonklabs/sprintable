// @vitest-environment jsdom
//
// story #2533 follow-up(유나 design 재검, 2026-08-09) — falsified 색은 info(청) 유지 확定
// (반증=학습 신호, red는 kill 전용 원칙 위반이라 유나가 자기 시안의 red를 자기정정). 대신
// 글리프를 ⊘→✕로 바꿔 "닫힘 아니라 낳음"이 색이 아니라 방향으로 읽히게 한다. 이 결정을
// 값으로 고정한다 — 직접 테스트가 없던 컴포넌트라 신설.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HypothesisStatusBadge } from './hypothesis-status-badge';

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
});

describe('HypothesisStatusBadge — falsified(유나 design 재검, 2026-08-09 확定)', () => {
  it('색은 info(청) 유지 — destructive(빨강) 아님(Soul lock §12.1)', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="falsified" />)));
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge?.className).toContain('bg-info-tint');
    expect(badge?.className).not.toContain('bg-destructive');
  });

  it('글리프는 ✕(follow-up① — ⊘에서 교체)', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="falsified" />)));
    expect(container.textContent).toContain('✕');
    expect(container.textContent).not.toContain('⊘');
  });

  it('라벨 텍스트("반증됨")를 항상 동반한다(AC8 — 색만으로 구분 금지)', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="falsified" />)));
    expect(container.textContent).toContain(koMessages.hypotheses.statusFalsified);
  });
});

describe('HypothesisStatusBadge — killed(색 규율 완성, 유나 design 2026-08-09, #2930 재QA)', () => {
  it('색은 destructive(빨강) — 색 규율에서 빨강의 유일한 자리', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="killed" />)));
    const badge = container.querySelector('[data-slot="badge"]');
    expect(badge?.className).toContain('bg-destructive');
  });

  it('글리프는 ⊘ — falsified(✕)와 안 겹친다', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="killed" />)));
    expect(container.textContent).toContain('⊘');
    expect(container.textContent).not.toContain('✕');
  });

  it('라벨 텍스트("종료")를 항상 동반한다(AC8)', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="killed" />)));
    expect(container.textContent).toContain(koMessages.hypotheses.statusKilled);
  });
});
