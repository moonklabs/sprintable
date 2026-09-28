// @vitest-environment jsdom
/**
 * story #4370 — 「오늘」 · 채팅 v3 사유 창 초안(유나 규칙: 닫는 길과 무관하게 유지 · 보이는 «취소»와 성공에서만 지움 · 대상별).
 * 예전엔 거꾸로(Dialog 자체 닫힘에서만 지우고 «취소» · 성공은 남김). 두 창은 이제 한 컴포넌트(채팅 v3 사본을 걷음)라 둘 다 같은 판으로 잰다.
 * 닫힘은 실제 사용 순서(칸 초점 → Esc 두 번, 4369)로 일으킨다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect, useState, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TodayV3ReasonDialog } from './today-v3-reason-dialog';
import { ChatV3ReasonDialog } from '@/components/chat-v3/chat-v3-reason-dialog';

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

const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };

type Dlg = ComponentType<Omit<React.ComponentProps<typeof TodayV3ReasonDialog>, 'testIdPrefix'>>;
const CASES: Array<[string, Dlg, string]> = [
  ['오늘', TodayV3ReasonDialog as Dlg, 'today-v3'],
  ['채팅 v3', ChatV3ReasonDialog, 'chat-v3'],
];

describe.each(CASES)('%s 사유 창 초안(story #4370)', (_label, Dialog, prefix) => {
  const ctl: { open?: (id: string | null) => void } = {};
  let submitResult = true;
  const field = () => document.body.querySelector<HTMLTextAreaElement>(`[data-testid="${prefix}-reason-textarea"]`);
  const submitBtn = () => document.body.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-reason-submit"]`);
  const cancelBtn = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === '그만두기');

  async function mount() {
    function Harness() {
      const [target, setTarget] = useState<string | null>(null);
      useEffect(() => { ctl.open = setTarget; }, []);
      return (
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <Dialog
            open={target !== null}
            onOpenChange={(open) => { if (!open) setTarget(null); }}
            title="사유" placeholder="사유를 적어 주세요" submitLabel="보내기" cancelLabel="그만두기"
            reasonRequired submitting={false}
            onSubmit={async () => { if (submitResult) setTarget(null); return submitResult; }}
            draftKey={{ surface: `${prefix}-test`, targetId: target }}
          />
        </NextIntlClientProvider>
      );
    }
    await act(async () => { root.render(<Harness />); });
  }
  async function openFor(id: string) { await act(async () => { ctl.open!(id); }); await settle(); }
  async function type(text: string) {
    const el = field()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
  }
  async function closeByEsc() {
    await act(async () => { field()!.focus(); });
    await act(async () => { esc(field()!); });
    await act(async () => { esc(document.activeElement ?? document.body); });
    await settle();
  }

  it('Esc(창 자체 닫힘)로 닫아도 다시 열면 사유가 남는다', async () => {
    await mount();
    await openFor('t-a');
    await type('쓰던 사유');
    await closeByEsc();
    expect(field()).toBeNull();
    await openFor('t-a');
    expect(field()!.value).toBe('쓰던 사유');
  });

  it('보이는 «취소»는 지운다', async () => {
    await mount();
    await openFor('t-a');
    await type('버릴 사유');
    await act(async () => { cancelBtn()!.click(); });
    await settle();
    await openFor('t-a');
    expect(field()!.value).toBe('');
  });

  it('성공은 지우고 · 실패는 남긴다', async () => {
    await mount();
    await openFor('t-a');
    await type('보낼 사유');
    submitResult = false;
    await act(async () => { submitBtn()!.click(); });
    await settle();
    expect(field()!.value).toBe('보낼 사유');
    submitResult = true;
    await act(async () => { submitBtn()!.click(); });
    await settle();
    await openFor('t-a');
    expect(field()!.value).toBe('');
  });

  it('다른 대상 창엔 안 샌다', async () => {
    await mount();
    await openFor('t-a');
    await type('A 사유');
    await closeByEsc();
    await openFor('t-b');
    expect(field()!.value).toBe('');
  });
});
