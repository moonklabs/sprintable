// @vitest-environment jsdom
/**
 * story #4558(유나 AC0 정본 §1 · PO 2026-10-07) — 결정 패널의 낱말이 한 일을 하나로 부른다.
 * - 고위험(`mode="decide"` · 이 패널이 유일한 길): [반려](outline) · [승인하고 서명](주) · [보류(논의 필요)] — «변경 요청» 0.
 * - 저위험 [반려] 진입(`mode="reject"`): 반려 전용 — [반려](주 · destructive) · [취소]뿐. «승인하고 서명» 0 · «보류» 0 ·
 *   «승인은 내 서명으로 기록돼요» 0(승인이 없는 패널). 근거 확인 체크 · 사유 칸은 그대로(경계).
 * - 반려 단추 아이콘은 연필(«고쳐 달라»)이 아니다.
 * 되돌리면(mode 무시 · 옛 낱말) RED.
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

function gate(overrides: Partial<GateItem> = {}): GateItem {
  return {
    id: 'gate-4558', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story', gate_type: 'qa', status: 'pending',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null, requires_human: true, risk_grade: 'high',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides,
  } as GateItem;
}

const ko = koMessages.cage as Record<string, string>;
const en = enMessages.cage as Record<string, string>;
const labels = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).map((b) => b.textContent?.trim());
const btn = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);

async function mount(props: { mode?: 'decide' | 'reject'; onCancel?: () => void; onDiscuss?: () => void; locale?: 'ko' | 'en' }) {
  const { locale = 'ko', ...rest } = props;
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={locale === 'ko' ? koMessages : enMessages} timeZone="Asia/Seoul">
        <GateSignatureApproval gate={gate()} resolving={false} onApprove={() => undefined} onReject={() => undefined} {...rest} />
      </NextIntlClientProvider>,
    );
  });
}

describe('GateSignatureApproval — 낱말 하나 «반려»(story #4558)', () => {
  it('고위험(decide): [반려] · [승인하고 서명] · [보류(논의 필요)] — «변경 요청» 없음', async () => {
    await mount({ mode: 'decide', onDiscuss: () => undefined });
    expect(labels()).toEqual(expect.arrayContaining([ko.sigReject, ko.sigApproveAndSign, ko.gateDiscussSubmit]));
    expect(ko.sigReject).toBe('반려');
    expect(container.textContent).not.toContain('변경 요청');
    expect(container.textContent).toContain(ko.sigConsequenceNote);
    // 주 단추는 «승인하고 서명»(default variant = bg-primary) · 반려는 주 단추가 아니다(bg-primary 0 · bg-destructive 0)
    expect(btn(ko.sigApproveAndSign)!.className).toContain('bg-primary');
    expect(btn(ko.sigReject)!.className).not.toContain('bg-primary');
    expect(btn(ko.sigReject)!.className).not.toContain('bg-destructive');
  });

  it('mode 생략 = decide(기존 부르는 쪽 회귀 0)', async () => {
    await mount({ onDiscuss: () => undefined });
    expect(labels()).toEqual(expect.arrayContaining([ko.sigReject, ko.sigApproveAndSign, ko.gateDiscussSubmit]));
  });

  it('저위험 [반려] 진입(reject): [반려](주 · destructive) · [취소]뿐 — 승인 0 · 보류 0 · «승인은 내 서명으로 기록돼요» 0', async () => {
    await mount({ mode: 'reject', onCancel: () => undefined, onDiscuss: () => undefined });
    expect(labels().filter(Boolean)).toEqual([ko.sigReject, ko.cancel]);
    expect(container.textContent).not.toContain(ko.sigApproveAndSign);
    expect(container.textContent).not.toContain(ko.gateDiscussSubmit);
    expect(container.textContent).not.toContain(ko.sigConsequenceNote);
    expect(btn(ko.sigReject)!.className).toContain('bg-destructive');
    // 경계: 근거 확인 체크 · 사유 칸은 두 모드 같다
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector('#gate-sig-reason')).toBeTruthy();
  });

  it('반려 전용 패널도 사유 없인 [반려]가 잠긴다(story #3334 축 그대로) · 사유를 쓰면 풀린다', async () => {
    await mount({ mode: 'reject', onCancel: () => undefined });
    const reject = btn(ko.sigReject)!;
    expect(reject.disabled).toBe(true);
    const el = container.querySelector<HTMLTextAreaElement>('#gate-sig-reason')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, '반려 사유');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(btn(ko.sigReject)!.disabled).toBe(false);
  });

  it('반려 단추의 아이콘은 연필이 아니다(«고쳐 달라»의 뜻) — XCircle', async () => {
    await mount({ mode: 'decide' });
    const svg = btn(ko.sigReject)!.querySelector('svg')!;
    expect(svg.getAttribute('class') ?? '').not.toContain('pencil');
    expect(svg.getAttribute('class') ?? '').toContain('circle-x');
  });

  it('en: Reject · Approve & sign · Hold for discussion — "Request changes" 없음', async () => {
    await mount({ mode: 'decide', onDiscuss: () => undefined, locale: 'en' });
    expect(en.sigReject).toBe('Reject');
    expect(en.sigApproveAndSign).toBe('Approve & sign');
    expect(labels()).toEqual(expect.arrayContaining([en.sigReject, en.sigApproveAndSign, en.gateDiscussSubmit]));
    expect(container.textContent).not.toContain('Request changes');
  });
});
