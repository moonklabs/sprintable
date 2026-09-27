// @vitest-environment jsdom
/**
 * story #4370 — 고위험 서명 사유 초안: 창 · 패널이 닫히거나 떠나도(언마운트) 남고, 결재 성공(부르는 쪽이 true)에서만 지운다.
 * 키 = 게이트 + 검토 대상(머리 SHA · 초안 버전) — 새 버전이면 빈 칸(story #4190 «새 버전은 다시 보고 서명»과 같은 결).
 * 부르는 쪽이 성공을 안 알리면(void · false) 남긴다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
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
    id: 'gate-1', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story', gate_type: 'merge_gate', status: 'pending',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null, requires_human: true, risk_grade: 'high',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides,
  } as GateItem;
}

const cage = koMessages.cage as Record<string, string>;
const field = () => container.querySelector<HTMLTextAreaElement>('#gate-sig-reason');
const btn = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

let approveResult: () => void | Promise<boolean | void> = async () => true;
async function mount(g: GateItem) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <GateSignatureApproval gate={g} resolving={false} onApprove={() => approveResult()} onReject={() => approveResult()} />
      </NextIntlClientProvider>,
    );
  });
}
async function unmountLayer() { await act(async () => { root.render(<></>); }); }
async function type(text: string) {
  const el = field()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('GateSignatureApproval 서명 사유 초안(story #4370)', () => {
  it('창 · 패널이 닫혀(언마운트) 다시 열어도 사유가 남는다', async () => {
    await mount(gate());
    await type('근거 확인 후 서명 사유');
    await unmountLayer();
    await mount(gate());
    expect(field()!.value).toBe('근거 확인 후 서명 사유');
  });

  it('결재 성공(true)이면 지우고 · 성공을 안 알리면(void) 남긴다', async () => {
    await mount(gate());
    await type('변경 요청 사유');
    approveResult = () => undefined;
    await act(async () => { btn(cage.sigRequestChanges).click(); });
    await settle();
    await unmountLayer();
    await mount(gate());
    expect(field()!.value).toBe('변경 요청 사유');
    approveResult = async () => true;
    await act(async () => { btn(cage.sigRequestChanges).click(); });
    await settle();
    await unmountLayer();
    await mount(gate());
    expect(field()!.value).toBe('');
  });

  it('실패(false)면 남긴다', async () => {
    await mount(gate());
    await type('보낼 사유');
    approveResult = async () => false;
    await act(async () => { btn(cage.sigRequestChanges).click(); });
    await settle();
    await unmountLayer();
    await mount(gate());
    expect(field()!.value).toBe('보낼 사유');
  });

  it('다른 게이트 · 같은 게이트의 새 검토 대상(머리 SHA)이면 빈 칸', async () => {
    await mount(gate({ id: 'gate-1', github_check_run_sha: 'sha-a' }));
    await type('sha-a 검토 사유');
    await unmountLayer();
    await mount(gate({ id: 'gate-2', github_check_run_sha: 'sha-a' }));
    expect(field()!.value).toBe('');
    await unmountLayer();
    await mount(gate({ id: 'gate-1', github_check_run_sha: 'sha-b' }));
    expect(field()!.value).toBe('');
    await unmountLayer();
    await mount(gate({ id: 'gate-1', github_check_run_sha: 'sha-a' }));
    expect(field()!.value).toBe('sha-a 검토 사유');
  });
});
