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

// story #4370(유나 규칙) — 확인 조작은 초안에 절대 안 들어간다: «근거를 확인했어요» 체크는 다시 열면 늘 꺼진 채 · 같은 폼의 사유는 돌아온다.
// (확인은 «지금 이 화면에서 다시 봤다»는 뜻 — 되살리면 안 본 채로 서명이 켜진다.)
describe('GateSignatureApproval — 확인 체크는 초안 제외(story #4370)', () => {
  it('체크 + 사유 입력 → 닫았다 열면 사유만 돌아오고 체크는 꺼져 있다', async () => {
    await mount(gate());
    const box = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { box().click(); });
    expect(box().checked).toBe(true);
    await type('근거 보고 서명');
    await unmountLayer();
    await mount(gate());
    expect(field()!.value).toBe('근거 보고 서명');
    expect(box().checked).toBe(false);
    expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith('sprintable:field-draft:')).every((k) => !/evidence|confirm|ack/i.test(k))).toBe(true);
  });
});

// 까디르 P2 — 부르는 쪽 key에 게이트 id가 빠져 있어, SHA · 버전이 같은(둘 다 빈) 다른 게이트로 옮기면 같은 컴포넌트가 다시 쓰이며
// 체크가 켜진 채 남았다. 이제 체크는 체크한 대상(게이트 + SHA + 버전)에만 묶인다 — key가 무엇이든.
describe('GateSignatureApproval — 확인 체크는 다른 게이트로 옮기면 꺼진다(story #4370 · 까디르 P2)', () => {
  it('게이트 A에서 체크 → 같은 SHA · 버전의 게이트 B(같은 인스턴스, key 바뀜 없음) → 꺼져 있다 · A로 돌아와도 다시 체크해야', async () => {
    const box = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await mount(gate({ id: 'gate-a' }));
    await act(async () => { box().click(); });
    expect(box().checked).toBe(true);
    await mount(gate({ id: 'gate-b' }));
    expect(box().checked).toBe(false);
    await mount(gate({ id: 'gate-a' }));
    expect(box().checked).toBe(false);
  });
});

describe('GateSignatureApproval — onCancel(보이는 «취소»)는 사유 초안을 지우고 부른다(story #4370 · 까디르 P3)', () => {
  it('onCancel이 있으면 «취소»가 보이고, 누르면 초안이 지워지고 onCancel이 불린다 · 없으면 버튼이 없다', async () => {
    const cancelLabel = (koMessages.cage as unknown as Record<string, string>).cancel;
    let cancelled = 0;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <GateSignatureApproval gate={gate({ risk_grade: 'low' })} resolving={false} onApprove={() => undefined} onReject={() => undefined} onCancel={() => { cancelled += 1; }} />
        </NextIntlClientProvider>,
      );
    });
    await type('버릴 사유');
    await act(async () => { btn(cancelLabel).click(); });
    expect(cancelled).toBe(1);
    await unmountLayer();
    await mount(gate({ risk_grade: 'low' }));
    expect(field()!.value).toBe('');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.trim() === cancelLabel)).toBe(false);
  });
});

