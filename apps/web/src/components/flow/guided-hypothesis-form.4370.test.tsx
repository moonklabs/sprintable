// @vitest-environment jsdom
/**
 * story #4370(유나 판정 (가)) — 안내 가설 폼: 여러 줄 칸(가설 문장)이 든 폼이라 폼 전체가 프로젝트별 초안 하나.
 * 창/시트가 닫혀(언마운트) 다시 열면 그대로 · 보이는 «취소»와 만들기 성공에서만 지운다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GuidedHypothesisForm } from './guided-hypothesis-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const f = koMessages.flow as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
let submitOk = true;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  submitOk = true;
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const statement = () => container.querySelector<HTMLTextAreaElement>(`textarea[placeholder="${f.guidedStatementPlaceholder}"]`);
const metric = () => container.querySelector<HTMLInputElement>(`input[placeholder="${f.guidedMetricPlaceholder}"]`);
const target = () => container.querySelector<HTMLInputElement>(`input[placeholder="${f.guidedTargetPlaceholder}"]`);
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

async function open() {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <GuidedHypothesisForm projectId="p1" onSubmit={async () => submitOk} onCancel={() => {}} />
      </NextIntlClientProvider>,
    );
  });
}
async function close() { await act(async () => { root.render(<></>); }); }
async function setValue(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function fillAll() {
  await setValue(statement()!, '온보딩을 줄이면 완료율이 오른다');
  await setValue(metric()!, '첫 스토리 완료율');
  await setValue(target()!, '40');
}

describe('안내 가설 폼 초안(story #4370)', () => {
  it('닫았다 열면 문장 · 지표 · 목표(폼 전체)가 남는다', async () => {
    await open();
    await fillAll();
    await close();
    await open();
    expect(statement()!.value).toBe('온보딩을 줄이면 완료율이 오른다');
    expect(metric()!.value).toBe('첫 스토리 완료율');
    expect(target()!.value).toBe('40');
  });

  it('보이는 «취소»는 지운다', async () => {
    await open();
    await fillAll();
    const cancel = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === f.guidedCancel)!;
    await act(async () => { cancel.click(); });
    await close();
    await open();
    expect(statement()!.value).toBe('');
  });

  it('만들기 실패는 남기고 · 성공은 지운다', async () => {
    await open();
    await fillAll();
    const form = container.querySelector('form')!;
    submitOk = false;
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    await close();
    await open();
    expect(statement()!.value).toBe('온보딩을 줄이면 완료율이 오른다');
    submitOk = true;
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle();
    await close();
    await open();
    expect(statement()!.value).toBe('');
  });
});
