// @vitest-environment jsdom
/**
 * story #4370(유나 판정 (가)) — 스프린트 만들기 창: 여러 줄 칸(가설 문장 카드)이 든 폼이라 **폼 전체**(이름 · 목표 · 기간 · …)가
 * 프로젝트별 초안 하나. 창이 닫혀(부모가 언마운트) 다시 열면 그대로 · 보이는 «취소»와 만들기 성공에서만 지움.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sp = koMessages.sprints as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
let createOk = true;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  createOk = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sprints' && init?.method === 'POST') {
      return createOk
        ? { ok: true, text: async () => '', json: async () => ({ data: { id: 'sp-new', title: 'x', status: 'planning' } }) }
        : { ok: false, text: async () => 'fail', json: async () => null };
    }
    return { ok: false, text: async () => '', json: async () => null };
  }));
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };
const titleInput = () => document.body.querySelector<HTMLInputElement>(`input[placeholder="${sp.sprintTitlePlaceholder}"]`);
const goalInput = () => document.body.querySelector<HTMLInputElement>(`input[placeholder="${sp.goalPlaceholder}"]`);
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);

const ctl: { setShow?: (v: boolean) => void } = {};
async function mount() {
  const { CreateDialog } = await import('./sprints-client');
  function Parent() {  // 실제 부모처럼 showCreate로 창을 조건부 마운트
    const [show, setShow] = useState(false);
    useEffect(() => { ctl.setShow = setShow; }, []);
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        {show ? <CreateDialog projectId="proj-1" onCreated={() => setShow(false)} onClose={() => setShow(false)} /> : null}
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Parent />); });
}
async function open() { await act(async () => { ctl.setShow!(true); }); await settle(); }
async function closeLayer() { await act(async () => { ctl.setShow!(false); }); }  // ✕ · 바깥 · Esc = 부모가 창을 내림
async function setValue(el: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('스프린트 만들기 창 폼 초안(story #4370)', () => {
  it('닫았다(✕ · 바깥 · Esc — 부모가 언마운트) 다시 열면 이름 · 목표가 남아 있다', async () => {
    await mount();
    await open();
    await setValue(titleInput()!, '10월 스프린트');
    await setValue(goalInput()!, '결제 흐름 마무리');
    await closeLayer();
    await open();
    expect(titleInput()!.value).toBe('10월 스프린트');
    expect(goalInput()!.value).toBe('결제 흐름 마무리');
  });

  it('보이는 «취소»는 폼 초안을 지운다', async () => {
    await mount();
    await open();
    await setValue(titleInput()!, '버릴 스프린트');
    await act(async () => { button(sp.cancel)!.click(); });
    await settle();
    await open();
    expect(titleInput()!.value).toBe('');
  });

  it('만들기 실패는 남기고 · 성공은 지운다', async () => {
    await mount();
    await open();
    await setValue(titleInput()!, '만들 스프린트');
    createOk = false;
    await act(async () => { button(sp.saveDraft)!.click(); });
    await settle();
    expect(titleInput()!.value).toBe('만들 스프린트');
    createOk = true;
    await act(async () => { button(sp.saveDraft)!.click(); });
    await settle();
    await open();
    expect(titleInput()!.value).toBe('');
  });
});
