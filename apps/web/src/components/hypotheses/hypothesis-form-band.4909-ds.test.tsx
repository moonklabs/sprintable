// @vitest-environment jsdom
//
// 4909 AC3 (가설 칸 3단계) — the hypothesis form and the gate band on the ds parts. The form keeps its THREE manual fields (statement · metric/threshold · measure date) and its submit value; each field is a ds `Field`, the inputs are the field layer,
// the buttons are ds Buttons. The band's state is a ds Chip (waiting amber · confirmed green · rejected red) on the «글 줄» layer face. Every test goes RED if the thing it names is put back the old way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { LAYER } from '@/components/ds/layers';
import type { GateItem } from '@/components/kanban/types';
import { HypothesisForm, type HypothesisFormValue } from './hypothesis-form';
import { HypothesisGateBadge } from './hypothesis-gate-badge';
import { HYPOTHESIS_BAND_FACE } from './hypotheses-face';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const T = koMessages.hypotheses as unknown as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });
const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
const mount = async (node: React.ReactNode) => { await act(async () => { root.render(wrap(node)); }); await act(async () => { await Promise.resolve(); }); };
const tokens = (el: Element) => el.className.split(/\s+/);
const q = <E extends Element>(sel: string) => container.querySelector(sel) as E;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];
const btn = (text: string) => qa('button').find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('HypothesisForm — 4909 ds 부품 (칸 셋 · 값 그대로)', () => {
  it('⭐EXACTLY three fields, each a ds Field with its visible name — statement · metric/threshold · measure date (never a fourth)', async () => {
    await mount(<HypothesisForm onSubmit={() => {}} onCancel={() => {}} />);
    const fields = qa('[data-slot="ds-field"]');
    expect(fields).toHaveLength(3);
    expect(fields.map((f) => f.querySelector('label')?.textContent)).toEqual([T.statementField, T.metricField, T.measureAfterField]);
    // the name is tied to its control (label for = id)
    for (const f of fields) {
      const label = f.querySelector('label')!; const control = f.querySelector(`[id="${label.getAttribute('for')}"]`);
      expect(control, label.textContent ?? '').toBeTruthy();
    }
    expect(qa('form [data-slot="ds-field"]')).toHaveLength(3);
  });

  it('⭐the controls are the ds parts on the FIELD layer (surface-sunk): textarea · metric input · source select · target number · date — and none keeps the old page-coloured face', async () => {
    await mount(<HypothesisForm onSubmit={() => {}} onCancel={() => {}} />);
    expect(q('textarea').getAttribute('data-slot')).toBe('ds-textarea');
    expect(qa('input').map((i) => i.getAttribute('data-slot'))).toEqual(['ds-input', 'ds-input', 'ds-input']);
    expect(q('[data-slot="ds-select"] select')).toBeTruthy();
    for (const c of [q('textarea'), ...qa('input'), q('[data-slot="ds-select"] select')]) expect(tokens(c)).toContain(LAYER.field);
    expect(q('form').innerHTML).not.toMatch(/bg-background|bg-muted|rounded-xl|bg-primary/);
    expect(tokens(q('form'))).toEqual(expect.arrayContaining(['rounded-ds-control', 'border-ds-line']));
  });

  it('⭐the direction toggle is two ds Buttons with aria-pressed (the chosen one primary) — and the chosen direction goes into the submitted value', async () => {
    const onSubmit = vi.fn<(v: HypothesisFormValue) => void>();
    await mount(<HypothesisForm onSubmit={onSubmit} onCancel={() => {}} />);
    const [up, down] = [btn(T.dirUp), btn(T.dirDown)];
    expect([up, down].every((b) => b.getAttribute('data-slot') === 'ds-button')).toBe(true);
    expect([up.getAttribute('aria-pressed'), down.getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    expect(tokens(up)).toContain('bg-ds-action');
    expect(tokens(down)).not.toContain('bg-ds-action');
    await act(async () => { down.click(); });
    expect([btn(T.dirUp).getAttribute('aria-pressed'), btn(T.dirDown).getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    expect(tokens(btn(T.dirDown))).toContain('bg-ds-action');
    await act(async () => { setInput(q('textarea'), '가설 문장'); setInput(qa('input')[0] as HTMLInputElement, '이탈률'); setInput(q('input[type=date]'), '2026-12-01'); });
    await act(async () => { q('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ statement: '가설 문장', measure_after: '2026-12-01', metric_definition: { metric: '이탈률', direction: 'down' } });
  });

  it('⭐the submit needs ALL of statement · metric · date — dropping any one keeps it disabled (codex 1: the old check only tried none and all)', async () => {
    await mount(<HypothesisForm onSubmit={() => {}} onCancel={() => {}} />);
    const submitDisabled = () => q<HTMLButtonElement>('button[type=submit]').disabled;
    const fill = async (parts: { statement?: string; metric?: string; date?: string }) => {
      await act(async () => {
        setInput(q('textarea'), parts.statement ?? ''); setInput(qa('input')[0] as HTMLInputElement, parts.metric ?? ''); setInput(q('input[type=date]'), parts.date ?? '');
      });
    };
    await fill({ statement: 's', metric: 'm', date: '2026-12-01' });
    expect(submitDisabled()).toBe(false);
    await fill({ metric: 'm', date: '2026-12-01' }); expect(submitDisabled()).toBe(true); // no statement
    await fill({ statement: 's', date: '2026-12-01' }); expect(submitDisabled()).toBe(true); // no metric
    await fill({ statement: 's', metric: 'm' }); expect(submitDisabled()).toBe(true); // no date
    await fill({ statement: '   ', metric: 'm', date: '2026-12-01' }); expect(submitDisabled()).toBe(true); // blank statement
    await fill({ statement: 's', metric: '  ', date: '2026-12-01' }); expect(submitDisabled()).toBe(true); // blank metric
  });

  it('cancel is the quiet ds Button and the submit the primary one (disabled until the three are filled; «저장 중» while submitting) — the same handlers', async () => {
    const onCancel = vi.fn();
    await mount(<HypothesisForm onSubmit={() => {}} onCancel={onCancel} />);
    const cancel = btn(T.cancel); const submit = q<HTMLButtonElement>('button[type=submit]');
    expect(tokens(cancel)).toEqual(expect.arrayContaining(['border-transparent', 'text-ds-ink-2']));
    expect(tokens(submit)).toContain('bg-ds-action');
    expect(submit.disabled).toBe(true);
    await act(async () => { cancel.click(); });
    expect(onCancel).toHaveBeenCalledTimes(1);
    await act(async () => { setInput(q('textarea'), 'a'); setInput(qa('input')[0] as HTMLInputElement, 'm'); setInput(q('input[type=date]'), '2026-12-01'); });
    expect(q<HTMLButtonElement>('button[type=submit]').disabled).toBe(false);
    await mount(<HypothesisForm submitting onSubmit={() => {}} onCancel={() => {}} initial={{ statement: 'a', measure_after: '2026-12-01', metric_definition: { metric: 'm', source: 'manual', target: 1, direction: 'up' } }} />);
    expect(q<HTMLButtonElement>('button[type=submit]').textContent).toContain(koMessages.common.saving);
    expect(q<HTMLButtonElement>('button[type=submit]').disabled).toBe(true);
  });
});

describe('HypothesisGateBadge — 4909 ds Chip + 글 줄 면 + ds Button', () => {
  const HYP = (over: Record<string, unknown> = {}) => ({ id: 'h-1', statement: 's', status: 'proposed', confirmed_by_member_id: null, drafted_by_member_id: null, ...over }) as unknown as Hypothesis;
  const GATE = (status: string) => ({ id: 'g-1', status, requires_human: true, work_item_type: 'hypothesis', work_item_id: 'h-1', resolver_id: 'm2' }) as unknown as GateItem;
  const band = () => q('[data-testid="hypothesis-gate-band"]');

  it('⭐the state is a ds Chip with its word and mark: waiting = needs-hand (amber) · confirmed = done (green) · rejected = failed (red)', async () => {
    const cases: Array<[Hypothesis, GateItem | undefined, string, string]> = [
      [HYP(), GATE('pending'), 'needs-hand', T.gatePending],
      [HYP({ confirmed_by_member_id: 'm1' }), undefined, 'done', T.gateConfirmed],
      [HYP(), GATE('rejected'), 'failed', T.gateRejected],
    ];
    for (const [h, g, tone, word] of cases) {
      await mount(<HypothesisGateBadge hypothesis={h} gate={g} resolveName={() => '송윤재'} />);
      expect(band().querySelector('[data-slot="ds-chip"]')?.getAttribute('data-tone')).toBe(tone);
      expect(band().querySelector('[data-slot="ds-chip"]')?.textContent).toContain(word);
      expect(band().querySelector('[data-slot="ds-chip"] svg'), `${word} keeps its shield mark`).toBeTruthy(); // the mark and the word, never colour alone
      expect(band().getAttribute('data-gate-state')).toBe(tone === 'needs-hand' ? 'pending' : tone === 'done' ? 'confirmed' : 'rejected');
    }
  });

  it('⭐the band face is the «글 줄» layer (LAYER.rowOthers) on the card — not the old muted wash', async () => {
    await mount(<HypothesisGateBadge hypothesis={HYP()} gate={GATE('pending')} />);
    expect(HYPOTHESIS_BAND_FACE).toBe(LAYER.rowOthers);
    expect(tokens(band())).toContain(LAYER.rowOthers);
    expect(band().className).not.toMatch(/bg-muted|rounded-xl|border-border/);
  });

  it('approve / reject are ds Buttons (secondary · danger), the reject note a ds Input, confirm danger · cancel quiet — the same requests', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await mount(<HypothesisGateBadge hypothesis={HYP()} gate={GATE('pending')} resolverId="me-1" />);
    const approve = btn(T.gateApprove); const reject = btn(T.gateReject);
    expect([approve, reject].every((b) => b.getAttribute('data-slot') === 'ds-button')).toBe(true);
    expect(tokens(approve)).toContain('border-ds-line-control'); // secondary
    expect(tokens(reject)).toContain('text-ds-failed'); // danger
    await act(async () => { reject.click(); });
    expect(q('input').getAttribute('data-slot')).toBe('ds-input');
    expect(tokens(btn(T.gateRejectConfirm))).toContain('text-ds-failed');
    expect(tokens(btn(T.gateCancel))).toContain('border-transparent');
    await act(async () => { btn(T.gateCancel).click(); });
    await act(async () => { btn(T.gateApprove).click(); await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/gates/g-1/transition');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'approved', resolver_id: 'me-1', note: null }); // the same request the old band sent
  });

  it('compact mode (the story chip) is unchanged: a small shield mark with its tooltip name and no chip', async () => {
    await mount(<HypothesisGateBadge hypothesis={HYP()} gate={GATE('pending')} compact />);
    expect(container.querySelector('[data-slot="ds-chip"]')).toBeNull();
    expect(container.querySelector(`[aria-label="${T.gatePending}"]`)).toBeTruthy();
    expect(container.querySelector(`[aria-label="${T.gatePending}"] svg`)).toBeTruthy(); // the small shield mark itself
  });
});
