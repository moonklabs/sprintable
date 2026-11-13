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
    const badge = container.querySelector('[data-slot="ds-chip"]');
    expect(badge?.getAttribute('data-tone')).toBe('info'); // 4909 AC3: the ds chip's info tone (blue)
    expect(badge?.getAttribute('data-tone')).not.toBe('failed');
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
    const badge = container.querySelector('[data-slot="ds-chip"]');
    expect(badge?.getAttribute('data-tone')).toBe('failed');
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

// 4909 AC3 (가설 칸 2단계) — the seven states on the ds Chip: the colour rule is ONE table (STATUS_TONE) and the soul lock holds: red only for killed, the verdict pair green / blue, measuring amber, the rest neutral; the word is always there.
import { STATUS_TONE } from './hypothesis-status-badge';
const ALL = ['proposed', 'active', 'measuring', 'verified', 'falsified', 'killed', 'archived'] as const;
describe('HypothesisStatusBadge — 4909 ds Chip 일곱 상태', () => {
  it.each(ALL)('⭐%s: ds Chip이고 상태 말(라벨)을 항상 동반한다', (status) => {
    act(() => root.render(wrap(<HypothesisStatusBadge status={status} />)));
    const chip = container.querySelector('[data-slot="ds-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute('data-status')).toBe(status);
    expect(chip?.textContent).toContain(koMessages.hypotheses[`status${status.charAt(0).toUpperCase()}${status.slice(1)}` as 'statusProposed']);
  });
  it('⭐색 규율(Soul lock): 빨강(failed)은 killed 하나뿐 · 검증됨 = done(녹) · 반증됨 = info(청) · 측정 중 = needs-hand(호박) · 나머지는 중립', () => {
    expect(STATUS_TONE).toEqual({ proposed: 'neutral', active: 'neutral', measuring: 'needs-hand', verified: 'done', falsified: 'info', killed: 'failed', archived: 'neutral' });
    expect(ALL.filter((s) => STATUS_TONE[s] === 'failed')).toEqual(['killed']);
    for (const s of ALL) {
      act(() => root.render(wrap(<HypothesisStatusBadge status={s} />)));
      expect(container.querySelector('[data-slot="ds-chip"]')?.getAttribute('data-tone')).toBe(STATUS_TONE[s]);
    }
  });
  it('proposed는 점선 윤곽 · active는 점 · archived는 가장 흐림 — 기호 · 윤곽으로도 갈린다', () => {
    act(() => root.render(wrap(<HypothesisStatusBadge status="proposed" />)));
    expect(container.querySelector('[data-slot="ds-chip"]')?.className).toContain('border-dashed');
    act(() => root.render(wrap(<HypothesisStatusBadge status="active" />)));
    expect(container.querySelector('[data-chip-dot]')).toBeTruthy();
    act(() => root.render(wrap(<HypothesisStatusBadge status="archived" />)));
    expect(container.querySelector('[data-slot="ds-chip"]')?.className).toContain('opacity-60');
  });
});
