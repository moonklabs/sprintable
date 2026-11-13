// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { LoopStageBar, LOOP_STAGE_ORDER, loopStageIndex } from './loop-stage-bar';
import { LoopStatusBadge, type LoopStatus } from './loop-status-badge';
import { OutcomeBadge } from './outcome-badge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const render = async (node: React.ReactNode) => {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
};
const states = () => Array.from(container.querySelectorAll('[data-slot="loop-stage-bar"] > span')).map((s) => s.getAttribute('data-state'));

describe('[SID:4911] LoopStageBar — 일곱 칸 단계 막대', () => {
  it('일곱 상태가 초안 → … → 종료 순서이고 중단은 그 줄 위에 없다', () => {
    expect(LOOP_STAGE_ORDER).toEqual(['draft', 'briefing', 'generating', 'deciding', 'executing', 'measuring', 'closed']);
    expect(loopStageIndex('abandoned')).toBe(-1);
  });

  it.each([
    ['draft', ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']],
    ['deciding', ['done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming']],
    ['executing', ['done', 'done', 'done', 'done', 'current', 'upcoming', 'upcoming']],
    ['closed', ['done', 'done', 'done', 'done', 'done', 'done', 'done']],
  ] as const)('%s: 앞 단계 = 채움 · 지금 = 윤곽 · 뒤 = 속 빈 칸 (종료는 일곱 칸이 다 참)', async (status, expected) => {
    await render(<LoopStageBar status={status} />);
    expect(states()).toEqual(expected);
  });

  it('색만으로 말하지 않는다: 그림(role=img)에 «7단계 중 N번째»가 달리고, 칸 자체는 숨김', async () => {
    await render(<LoopStageBar status="deciding" />);
    const bar = container.querySelector('[data-slot="loop-stage-bar"]')!;
    expect(bar.getAttribute('role')).toBe('img');
    expect(bar.getAttribute('aria-label')).toBe('7단계 중 4번째');
    expect(Array.from(bar.children).every((c) => c.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('중단(abandoned)은 막대를 그리지 않는다 — 칩이 «중단»을 말한다', async () => {
    await render(<LoopStageBar status="abandoned" />);
    expect(container.querySelector('[data-slot="loop-stage-bar"]')).toBeNull();
  });
});

describe('[SID:4911] 실행 상태 · 성과 칩 = ds Chip', () => {
  it.each([
    ['draft', 'neutral', false], ['briefing', 'info', true], ['generating', 'info', true], ['deciding', 'needs-hand', true],
    ['executing', 'info', true], ['measuring', 'info', true], ['closed', 'done', true], ['abandoned', 'neutral', true],
  ] as const)('%s → 칩 톤 %s · 점 %s · 글은 상태 이름', async (status, tone, dot) => {
    await render(<LoopStatusBadge status={status as LoopStatus} />);
    const chip = container.querySelector('[data-slot="ds-chip"]')!;
    expect(chip.getAttribute('data-tone')).toBe(tone);
    expect(!!chip.querySelector('[data-chip-dot]')).toBe(dot);
    expect(chip.textContent).toBeTruthy();
  });

  it('성과: 적중 = done(체크 아이콘) · 빗나감 = info — 반증에 빨강(failed)을 쓰지 않는다', async () => {
    await render(<><OutcomeBadge hypothesisStatus="verified" /><OutcomeBadge hypothesisStatus="falsified" /></>);
    const chips = Array.from(container.querySelectorAll('[data-slot="ds-chip"]'));
    expect(chips.map((c) => c.getAttribute('data-tone'))).toEqual(['done', 'info']);
    expect(chips[0]!.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(chips.map((c) => c.textContent)).toEqual(['적중', '빗나감']);
  });
});
