// @vitest-environment jsdom
/**
 * story #4370(유나 판정 (가)) — 스탠드업 피드백 창의 두 폼(새 피드백 · 고치기)은 폼 전체(글 · 종류)가 초안:
 * 창이 닫혀도(open=false) 다시 열어 폼을 펼치면 그대로 · 보이는 «취소»와 보내기/저장 성공에서만 지운다.
 * 예전엔 창이 닫히는 순간 effect가 글을 비웠다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StandupFeedbackDialog } from './standup-feedback-dialog';
import type { StandupFeedbackSummary } from './standup-types';

vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => ({}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const st = koMessages.standup as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const FEEDBACK: StandupFeedbackSummary = {
  id: 'f1', standup_entry_id: 'e1', feedback_by_id: 'me', review_type: 'comment', feedback_text: '저장된 피드백',
  created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T00:00:00Z',
} as StandupFeedbackSummary;

const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label);
const textareas = () => Array.from(document.body.querySelectorAll<HTMLTextAreaElement>('textarea'));
const newField = () => document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${st.feedbackPlaceholder}"]`);

const ctl: { setOpen?: (v: boolean) => void } = {};
async function mount() {
  function Parent() {
    const [open, setOpen] = useState(false);
    useEffect(() => { ctl.setOpen = setOpen; }, []);
    return (
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <StandupFeedbackDialog
          open={open} onOpenChange={setOpen}
          member={{ id: 'm-anna', name: '안나', type: 'human' }}
          entry={{ id: 'e1', author_id: 'm-anna', date: '2026-09-25', done: '', plan: '', blockers: null, plan_story_ids: [] }}
          feedback={[FEEDBACK]} stories={[]} memberNameById={{ me: '나' }} currentMemberId="me"
          onCreateFeedback={() => {}} onUpdateFeedback={() => {}} onDeleteFeedback={() => {}}
        />
      </NextIntlClientProvider>
    );
  }
  await act(async () => { root.render(<Parent />); });
}
async function setOpen(v: boolean) { await act(async () => { ctl.setOpen!(v); }); await settle(); }
async function type(el: HTMLTextAreaElement | HTMLInputElement, text: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('스탠드업 피드백 창 폼 초안(story #4370)', () => {
  it('새 피드백: 창을 닫았다 열어 폼을 펼치면 쓰던 글이 남아 있다 · «취소»는 지운다', async () => {
    await mount();
    await setOpen(true);
    await act(async () => { button(st.addFeedback)!.click(); });
    await act(async () => { button(st.markAsReview)!.click(); });  // 리뷰 = 여러 줄 칸
    await type(newField()!, '어제 막힌 부분 같이 봐요');
    await setOpen(false);
    await setOpen(true);
    await act(async () => { button(st.addFeedback)!.click(); });
    expect(newField()!.value).toBe('어제 막힌 부분 같이 봐요');
    await act(async () => { button(st.cancel)!.click(); });
    await act(async () => { button(st.addFeedback)!.click(); });
    expect(newField()!.value).toBe('');
  });

  it('고치기: 저장된 글이 처음 값 · 고친 글은 창을 닫아도 남고 · «취소»면 저장된 글로', async () => {
    await mount();
    await setOpen(true);
    await act(async () => { button(st.editFeedback)!.click(); });
    expect(textareas()[0]!.value).toBe('저장된 피드백');
    await type(textareas()[0]!, '저장된 피드백 + 덧붙임');
    await setOpen(false);
    await setOpen(true);
    await act(async () => { button(st.editFeedback)!.click(); });
    expect(textareas()[0]!.value).toBe('저장된 피드백 + 덧붙임');
    await act(async () => { button(st.cancel)!.click(); });
    await act(async () => { button(st.editFeedback)!.click(); });
    expect(textareas()[0]!.value).toBe('저장된 피드백');
  });
});
