// @vitest-environment jsdom
//
// story 4831 부품 교체(공용 부품 ①) — 성과 의도 칸(가설 문장 · 지표 · 목표 · 측정 시점)이 바탕 Textarea · Select · Input이 되어도 쓴 값이 onChange 값에 같은 모양으로 실리는지 결과로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OutcomeIntentFields, type OutcomeIntentValue } from './outcome-intent-fields';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

let latest: OutcomeIntentValue = { success_hypothesis: '', metric_definition: null, measure_after: '' };
function Harness() {
  const [v, setV] = useState<OutcomeIntentValue>(latest);
  useEffect(() => { latest = v; });
  return <OutcomeIntentFields value={v} onChange={setV} defaultOpen context="story" />;
}
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;

describe('성과 의도 칸 — 값이 onChange 값에 실린다(story 4831)', () => {
  it('문장 · 지표 · 목표 숫자 · 측정 시점이 실리고, 목표를 지우면 0이 된다', async () => {
    latest = { success_hypothesis: '', metric_definition: null, measure_after: '' };
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness /></NextIntlClientProvider>); });
    await act(async () => { setInput(q<HTMLTextAreaElement>('textarea[data-slot="textarea"]'), '로그인 단계를 줄이면 가입이 늘어난다'); });
    expect(latest.success_hypothesis).toBe('로그인 단계를 줄이면 가입이 늘어난다');

    const select = q<HTMLSelectElement>('select[data-slot="select"]');
    expect(select.value).toBe('velocity'); // 지표가 비어 있으면 첫 항목이 기본으로 보인다
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, 'progress');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(latest.metric_definition).toMatchObject({ metric: 'progress', source: 'internal_ops', direction: 'up' });

    expect(q<HTMLInputElement>('input[data-slot="input"][type=number]').className).toContain('sm:w-24'); // 자동 칸에서 목표 칸 폭을 부품의 w-full이 되돌리지 못한다
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][type=number]'), '40'); });
    expect(latest.metric_definition?.target).toBe(40);
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][type=number]'), ''); });
    expect(latest.metric_definition?.target).toBe(0);

    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][type=date]'), '2026-12-15'); });
    expect(latest.measure_after).toBe('2026-12-15');
  });
});
