// @vitest-environment jsdom
//
// story 4831 부품 교체(공용 부품 ①) — 가설 폼 · 판정 창 · 게이트 반려 사유 · 스토리 가설 연결 검색의 날것 칸이 바탕 Input · Select · Textarea가 되어도
// 쓴 값이 제출 값 · 요청 · 걸러진 목록으로 같은 모양으로 이어지는지 «결과»로 잠근다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { HypothesisForm, type HypothesisFormValue } from './hypothesis-form';
import { HypothesisResolveDialog, type HypothesisResolveResult } from './hypothesis-resolve-dialog';
import { HypothesisGateBadge } from './hypothesis-gate-badge';
import { StoryHypothesesSection } from './story-hypotheses-section';
import type { GateItem } from '@/components/kanban/types';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); fetchWithAuthMock.mockReset(); });

const th = koMessages.hypotheses as unknown as Record<string, string>;
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const mount = async (node: React.ReactNode) => { await act(async () => { root.render(wrap(node)); }); await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function setSelect(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
const submit = async (form: HTMLFormElement) => { await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };
const q = <T extends Element>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const buttonWith = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

describe('가설 폼 — 문장 · 지표 · 출처 · 방향 · 목표 · 측정 시점이 제출 값에 같은 모양으로 실린다(story 4831)', () => {
  it('빈 폼은 제출되지 않고, 다섯 칸을 채우면 제출 값에 문장 · 지표 · 출처 · 목표 숫자 · 날짜가 실린다', async () => {
    const onSubmit = vi.fn<(v: HypothesisFormValue) => void>();
    await mount(<HypothesisForm onSubmit={onSubmit} onCancel={() => {}} />);
    const form = q<HTMLFormElement>(container, 'form');
    await submit(form);
    expect(onSubmit).not.toHaveBeenCalled(); // 문장 · 지표 · 측정 시점이 비면 막힘

    await act(async () => { setInput(q(container, 'textarea[data-slot="ds-textarea"]'), '체크아웃을 줄이면 전환이 오른다'); });
    await act(async () => { setInput(q(container, `input[data-slot="ds-input"][placeholder="${th.metricPlaceholder}"]`), '전환율'); });
    await act(async () => { setSelect(q(container, '[data-slot="ds-select"] select'), 'manual'); });
    expect(q<HTMLInputElement>(container, 'input[data-slot="ds-input"][type=number]').className).toContain('sm:w-20'); // 자동 칸에서 목표 칸 폭을 부품의 w-full이 되돌리지 못한다
    await act(async () => { setInput(q(container, 'input[data-slot="ds-input"][type=number]'), '12.5'); });
    await act(async () => { setInput(q(container, 'input[data-slot="ds-input"][type=date]'), '2026-12-01'); });
    await submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({
      statement: '체크아웃을 줄이면 전환이 오른다',
      metric_definition: { metric: '전환율', source: 'manual', target: 12.5, direction: 'up' },
      measure_after: '2026-12-01',
    });
  });

  it('목표를 지우면 0으로 내려가고 화면 값은 비어 보인다(숫자 칸 규칙 그대로)', async () => {
    const onSubmit = vi.fn<(v: HypothesisFormValue) => void>();
    await mount(<HypothesisForm initial={{ statement: 's', metric_definition: { metric: 'm', source: 'internal_ops', target: 7, direction: 'down' }, measure_after: '2026-12-01' }} onSubmit={onSubmit} onCancel={() => {}} />);
    const target = q<HTMLInputElement>(container, 'input[data-slot="ds-input"][type=number]');
    expect(target.value).toBe('7');
    await act(async () => { setInput(target, ''); });
    await submit(q(container, 'form'));
    expect(onSubmit.mock.calls[0][0].metric_definition).toMatchObject({ target: 0, direction: 'down' });
  });
});

describe('가설 판정 창 — 실제 수치 · 근거가 제출되고 목표와 어긋나면 알린다(story 4831)', () => {
  const HYP = { id: 'h-1', statement: '결제 전환율을 올린다', status: 'measuring', metric_definition: { metric: '전환율', source: 'manual', target: 5, direction: 'up' } } as unknown as Hypothesis;
  const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
  it('수치와 근거를 쓰면 판정 저장이 켜지고 제출 값에 숫자 · 근거가 실린다', async () => {
    const onSubmit = vi.fn<(r: HypothesisResolveResult) => void>();
    await mount(<HypothesisResolveDialog hypothesis={HYP} target="verified" submitting={false} onSubmit={onSubmit} onCancel={() => {}} />);
    const actual = q<HTMLInputElement>(dialog(), 'input[data-slot="input"]#resolve-actual');
    const reason = q<HTMLInputElement>(dialog(), 'input[data-slot="input"]#resolve-reason');
    expect(actual.type).toBe('number');
    expect(reason.type).toBe('text');
    const save = buttonWith(dialog(), th.resolveSubmit);
    expect(save.disabled).toBe(true);
    await act(async () => { setInput(actual, '7'); });
    expect(save.disabled).toBe(true); // 근거 없이는 안 켜짐
    await act(async () => { setInput(reason, '  실측 결과가 목표를 넘었다  '); });
    expect(save.disabled).toBe(false);
    await submit(q(dialog(), 'form'));
    expect(onSubmit).toHaveBeenCalledWith({ actual: 7, reason: '실측 결과가 목표를 넘었다', target: 'verified' });
  });
  it('목표에 못 미치는 수치를 쓰면 어긋남 안내가 나타나고, 목표를 넘기면 사라진다', async () => {
    await mount(<HypothesisResolveDialog hypothesis={HYP} target="verified" submitting={false} onSubmit={() => {}} onCancel={() => {}} />);
    const actual = q<HTMLInputElement>(dialog(), '#resolve-actual');
    expect(dialog().textContent).not.toContain(th.mismatchVerifyWarning);
    await act(async () => { setInput(actual, '3'); });
    expect(dialog().textContent).toContain(th.mismatchVerifyWarning);
    await act(async () => { setInput(actual, '8'); });
    expect(dialog().textContent).not.toContain(th.mismatchVerifyWarning);
  });
});

describe('가설 게이트 띠 — 반려 사유 칸(story 4831)', () => {
  const HYP = { id: 'h-1', statement: 's', status: 'proposed', confirmed_by_member_id: null, drafted_by_member_id: null } as unknown as Hypothesis;
  const GATE = { id: 'g-1', status: 'pending', requires_human: true, work_item_type: 'hypothesis', work_item_id: 'h-1' } as unknown as GateItem;
  it('반려를 누르면 사유 칸이 나타나고, 사유를 써야 반려 확정이 켜져 사유와 함께 전환 요청이 나간다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const onResolved = vi.fn();
    await mount(<HypothesisGateBadge hypothesis={HYP} gate={GATE} resolverId="me-1" onResolved={onResolved} />);
    expect(container.querySelector('input')).toBeNull();
    await act(async () => { buttonWith(container, th.gateReject).click(); });
    const note = q<HTMLInputElement>(container, `input[data-slot="ds-input"][placeholder="${th.gateRejectNotePlaceholder}"]`);
    expect(note.type).toBe('text');
    const confirm = buttonWith(container, th.gateRejectConfirm);
    expect(confirm.disabled).toBe(true);
    await act(async () => { setInput(note, '근거가 부족하다'); });
    expect(confirm.disabled).toBe(false);
    await act(async () => { confirm.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/gates/g-1/transition');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'rejected', resolver_id: 'me-1', note: '근거가 부족하다' });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });
});

describe('스토리 가설 연결 — 검색 칸이 후보를 거르고 고른 후보가 연결 요청으로 나간다(story 4831)', () => {
  const CAND = [
    { id: 'h-1', statement: '결제 전환율을 올린다', status: 'active', epic_ids: [], story_ids: [] },
    { id: 'h-2', statement: '온보딩 이탈을 줄인다', status: 'active', epic_ids: [], story_ids: [] },
  ];
  it('검색어로 후보를 거르고(맞는 것이 없으면 없음 문구) 지우면 다시 둘, 후보를 누르면 그 가설로 POST /links가 나간다', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('story_id=')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.startsWith('/api/gates')) return { ok: true, json: async () => [] };
      return { ok: true, json: async () => ({ data: CAND }) };
    });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(<StoryHypothesesSection storyId="s-1" epicId={null} projectId="p-1" />);
    await act(async () => { buttonWith(container, th.linkHypothesis).click(); await Promise.resolve(); await Promise.resolve(); });
    const search = q<HTMLInputElement>(container, `input[data-slot="ds-input"][placeholder="${th.pickerSearch}"]`);
    expect(search).toBeTruthy();
    expect(container.textContent).toContain('결제 전환율을 올린다');
    expect(container.textContent).toContain('온보딩 이탈을 줄인다');
    await act(async () => { setInput(search, '결제'); });
    expect(container.textContent).toContain('결제 전환율을 올린다');
    expect(container.textContent).not.toContain('온보딩 이탈을 줄인다');
    await act(async () => { setInput(search, '없는 가설'); });
    expect(container.textContent).toContain(th.pickerEmpty);
    await act(async () => { setInput(search, ''); });
    expect(container.textContent).toContain('온보딩 이탈을 줄인다');
    await act(async () => { buttonWith(container, '온보딩 이탈을 줄인다').click(); await Promise.resolve(); await Promise.resolve(); });
    const link = fetchMock.mock.calls.find((c) => String((c as unknown as [string])[0]).includes('/links')) as unknown as [string, RequestInit];
    expect(link[0]).toBe('/api/hypotheses/h-2/links');
    expect(JSON.parse(String(link[1].body))).toEqual({ story_ids: ['s-1'], link_type: 'supports' });
  });
  it('검색 칸은 돋보기를 칸 안쪽 왼쪽에 얹는 한 칸 구조다(부품이 테두리를 갖고 겹치는 두 번째 테두리가 없다)', async () => {
    fetchWithAuthMock.mockImplementation(async () => ({ ok: true, json: async () => ({ data: [] }) }));
    await mount(<StoryHypothesesSection storyId="s-1" epicId={null} projectId="p-1" />);
    await act(async () => { buttonWith(container, th.linkHypothesis).click(); await Promise.resolve(); });
    const search = q<HTMLInputElement>(container, `input[data-slot="ds-input"][placeholder="${th.pickerSearch}"]`);
    expect(search.className).toContain('pl-7');
    expect(search.parentElement!.className).toBe('relative');
    expect(search.parentElement!.className).not.toContain('border');
  });
});
