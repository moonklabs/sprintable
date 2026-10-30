// @vitest-environment jsdom
/**
 * story #4833 (4814 실측) — 사유를 안 쓰면 «승인하고 서명»이 눌려도 아무 일도 없고 왜인지 안 보였다. 막힌 까닭을 단추 바로 위 한 줄로 말한다:
 * - 사유 · 근거 둘 다 비었다 → «결정 사유를 적어 주세요 — 승인하려면 근거 확인도 필요해요» (반려 · 보류는 사유만 있으면 되므로 근거를 «필수»로 말하지 않는다)
 * - 근거는 확인했고 사유만 비었다 → «결정 사유를 적어 주세요»
 * - 사유는 썼는데 근거를 안 봤다 → «승인하려면 위 근거를 확인했는지 체크해 주세요»
 * - 반려 전용 패널(근거 확인이 반려를 막지 않는다) → 사유만 («결정 사유를 적어 주세요»)
 * - 다 갖췄거나 처리 중 → 줄이 없다.
 * 한 줄을 지우면(되돌리면) RED.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import enMessages from '../../../messages/en.json';
import type { GateItem } from '@/components/kanban/types';
import { GateSignatureApproval } from './gate-signature-approval';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

function gate(): GateItem {
  return {
    id: 'gate-4833', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story', gate_type: 'qa', status: 'pending',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null, requires_human: true, risk_grade: 'high',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  } as GateItem;
}

const ko = koMessages.cage as Record<string, string>;
const en = enMessages.cage as Record<string, string>;
const hintNode = () => container.querySelector('[data-testid="gate-sig-hint"]');
const hint = () => hintNode()?.textContent || null; // '' (nothing to say) reads as null
const btn = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;

async function mount(props: { mode?: 'decide' | 'reject'; resolving?: boolean; locale?: 'ko' | 'en'; onDiscuss?: () => void; onCancel?: () => void } = {}) {
  const { locale = 'ko', resolving = false, ...rest } = props;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <GateSignatureApproval gate={gate()} resolving={resolving} onApprove={() => undefined} onReject={() => undefined} {...rest} />
      </NextIntlClientProvider>,
    );
  });
}
async function typeReason(text: string) {
  const el = container.querySelector<HTMLTextAreaElement>('#gate-sig-reason')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function tickEvidence() {
  const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await act(async () => { box.click(); });
}

describe('GateSignatureApproval — why the button is locked (story #4833)', () => {
  it('nothing done yet: says both things are missing', async () => {
    await mount();
    expect(hint()).toBe(ko.sigHintEvidenceAndReason);
    expect(ko.sigHintEvidenceAndReason).toContain('결정 사유');
  });

  it('evidence ticked, no reason: asks for the reason only', async () => {
    await mount();
    await tickEvidence();
    expect(hint()).toBe(ko.sigHintReason);
  });

  it('reason written, evidence not ticked: asks for the tick — approve is the ONLY locked button (reject and discuss are open)', async () => {
    await mount({ onDiscuss: () => undefined });
    await typeReason('사유를 적었어요');
    expect(hint()).toBe(ko.sigHintEvidence);
    expect(btn(ko.sigApproveAndSign).disabled).toBe(true);
    expect(btn(ko.sigReject).disabled).toBe(false);
    expect(btn(ko.gateDiscussSubmit).disabled).toBe(false);
  });

  it('nothing done: all three buttons are locked, and the words do not make the tick a condition of rejecting or discussing', async () => {
    await mount({ onDiscuss: () => undefined });
    expect(btn(ko.sigApproveAndSign).disabled).toBe(true);
    expect(btn(ko.sigReject).disabled).toBe(true);
    expect(btn(ko.gateDiscussSubmit).disabled).toBe(true);
    expect(ko.sigHintEvidenceAndReason).toContain('승인하려면');
    expect(ko.sigHintEvidenceAndReason.indexOf('결정 사유')).toBeLessThan(ko.sigHintEvidenceAndReason.indexOf('근거')); // the reason comes first, the tick is scoped to approving
  });

  it('the discuss caller: with a reason typed (no tick) discuss is open and the line asks only for the tick', async () => {
    let discussed = '';
    await mount({ onDiscuss: () => { discussed = 'yes'; } });
    await typeReason('논의가 필요해요');
    await act(async () => { btn(ko.gateDiscussSubmit).click(); });
    expect(discussed).toBe('yes');
  });

  it('the line is one live region that stays mounted: polite, atomic, and empty (sr-only) when there is nothing to say', async () => {
    await mount();
    const node = hintNode()!;
    expect(node.getAttribute('role')).toBe('status');
    expect(node.getAttribute('aria-live')).toBe('polite');
    expect(node.getAttribute('aria-atomic')).toBe('true');
    await tickEvidence();
    await typeReason('사유를 적었어요');
    expect(hintNode()).toBe(node); // the same node, not a new one
    expect(node.textContent).toBe('');
    expect(node.className).toContain('sr-only');
    await typeReason('');
    expect(hintNode()).toBe(node);
    expect(node.textContent).toBe(ko.sigHintReason);
  });

  it('everything in place: no hint line', async () => {
    await mount();
    await tickEvidence();
    await typeReason('사유를 적었어요');
    expect(hint()).toBeNull();
  });

  it('whitespace is not a reason', async () => {
    await mount();
    await tickEvidence();
    await typeReason('   ');
    expect(hint()).toBe(ko.sigHintReason);
  });

  it('while resolving: no hint line, and every visible button is locked (cancel too)', async () => {
    await mount({ resolving: true, onDiscuss: () => undefined, onCancel: () => undefined });
    expect(hint()).toBeNull();
    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    expect(labels.length).toBeGreaterThanOrEqual(4); // reject · approve · discuss · cancel
    expect(labels.every((b) => b.disabled)).toBe(true);
  });

  it('not resolving: cancel is open even when the form is incomplete (a person can always back out)', async () => {
    await mount({ onDiscuss: () => undefined, onCancel: () => undefined });
    expect(btn(ko.cancel).disabled).toBe(false);
  });

  it('reject-only panel: the reason is all it asks for (the tick does not gate a rejection)', async () => {
    await mount({ mode: 'reject' });
    expect(hint()).toBe(ko.sigHintReason);
    await typeReason('반려 사유');
    expect(hint()).toBeNull();
  });

  it('the English words exist and are not the Korean ones', async () => {
    await mount({ locale: 'en' });
    expect(hint()).toBe(en.sigHintEvidenceAndReason);
    expect(en.sigHintEvidenceAndReason).not.toBe(ko.sigHintEvidenceAndReason);
  });
});
