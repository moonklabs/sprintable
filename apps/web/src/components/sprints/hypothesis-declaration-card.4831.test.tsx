// @vitest-environment jsdom
//
// story 4831 부품 교체(보드 묶음) — 스프린트 가설 선언 카드의 날것 칸 9곳이 바탕 Input · Select · Textarea가 되어도 쓴 값이 선언 값(onChange)에 같은 모양으로 실리는지 결과로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HypothesisDeclarationCard } from './hypothesis-declaration-card';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null }))); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

let latest: HypothesisDeclarationValue = EMPTY_DECLARATION;
function Harness({ initial }: { initial: HypothesisDeclarationValue }) {
  const [v, setV] = useState(initial);
  useEffect(() => { latest = v; });
  return <HypothesisDeclarationCard projectId="proj-1" contextTitle="에픽" value={v} onChange={setV} linkableHypotheses={[]} />;
}
let mounts = 0;
const mount = async (initial: HypothesisDeclarationValue = EMPTY_DECLARATION) => {
  mounts += 1; // a new key per mount: the harness keeps its own state, so a second mount in one test must be a fresh component
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><Harness key={mounts} initial={initial} /></NextIntlClientProvider>); });
};
const th = koMessages.hypotheses as unknown as Record<string, string>;
const sp = koMessages.sprints as unknown as Record<string, string>;
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setSelect(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;

describe('스프린트 가설 선언 카드 — 새로 정의 모드의 칸들(story 4831)', () => {
  it('문장 · 지표 이름 · 출처 · 목표 · 측정 시점이 선언 값에 실리고, 출처를 GA4로 바꾸면 GA4 칸 셋이 나타나 값이 실린다', async () => {
    await mount();
    const statement = q<HTMLTextAreaElement>('textarea[data-slot="textarea"]');
    await act(async () => { setInput(statement, '체크아웃 개선이 전환을 올린다'); });
    expect(latest.statement).toBe('체크아웃 개선이 전환을 올린다');
    expect(latest.drafted).toBe(false);

    await act(async () => { setInput(q<HTMLInputElement>(`input[data-slot="input"][placeholder="${th.metricPlaceholder}"]`), '전환율'); });
    expect(latest.metricDefinition?.metric).toBe('전환율');
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][type=number][inputmode=decimal]'), '12.5'); });
    expect(latest.metricDefinition?.target).toBe(12.5);
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][type=date]'), '2026-12-01'); });
    expect(latest.measureAfter).toBe('2026-12-01');

    expect(container.querySelector('input[placeholder="GA4 property_id"]')).toBeNull(); // 출처가 GA4가 아니면 GA4 칸 없음
    await act(async () => { setSelect(q<HTMLSelectElement>('select[data-slot="select"]'), 'ga4'); });
    expect(latest.metricDefinition?.source).toBe('ga4');
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][placeholder="GA4 property_id"]'), '123456'); });
    expect(latest.metricDefinition?.property_id).toBe('123456');
    const ga4Select = container.querySelectorAll<HTMLSelectElement>('select[data-slot="select"]')[1]!;
    await act(async () => { setSelect(ga4Select, 'sessions'); });
    expect(latest.metricDefinition?.ga4_metric).toBe('sessions');
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][inputmode=numeric]'), '28'); });
    expect(latest.metricDefinition?.date_range_days).toBe(28);
    // 되돌려 비우면 undefined
    await act(async () => { setInput(q<HTMLInputElement>('input[data-slot="input"][inputmode=numeric]'), ''); });
    expect(latest.metricDefinition?.date_range_days).toBeUndefined();
  });

  it('초안으로 채워진 문장(drafted)은 칸 테두리가 primary로 바뀐다 · 아니면 부품 기본 테두리', async () => {
    await mount({ ...EMPTY_DECLARATION, statement: 'AI가 쓴 초안 문장입니다', drafted: true });
    expect(q<HTMLTextAreaElement>('textarea[data-slot="textarea"]').className).toContain('border-primary/40');
    await mount({ ...EMPTY_DECLARATION, statement: '직접 쓴 문장입니다' });
    expect(q<HTMLTextAreaElement>('textarea[data-slot="textarea"]').className).not.toContain('border-primary/40');
  });

  it('기존 링크 모드의 검색 칸은 바탕 Input이고 쓴 글자로 후보를 거른다', async () => {
    await mount({ ...EMPTY_DECLARATION, mode: 'link' });
    const search = q<HTMLInputElement>(`input[data-slot="input"][placeholder="${th.pickerSearch}"]`);
    expect(search).toBeTruthy();
    await act(async () => { setInput(search, '없는 가설'); });
    expect(container.textContent).toContain(th.pickerEmpty);
    void sp;
  });
});
