// @vitest-environment jsdom
//
// [SID:4369] 유나 규칙 — 창 · 시트(ui 원형 한 곳)에서: 글 있는 여러 줄 칸(반려/결재 사유 등)의 첫 Esc = 칸에서만(창 그대로 · 글 그대로) ·
// 둘째 Esc = 닫힘 · 조합 중 Esc = 그대로 · 빈 칸 · 한 줄 칸 = 한 번에 닫힘. 실제 Sheet · Dialog에 실제 칸.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { Sheet, SheetContent, SheetTitle } from './sheet';
import { Dialog, DialogContent, DialogTitle } from './dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const esc = (t: EventTarget, init: KeyboardEventInit = {}) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLTextAreaElement | HTMLInputElement | null;

for (const kind of ['Sheet', 'Dialog'] as const) {
  describe(`${kind} — 여러 줄 칸 Esc 규칙([SID:4369])`, () => {
    let onOpenChange: Mock<(open: boolean) => void>;
    async function mount() {
      onOpenChange = vi.fn<(open: boolean) => void>();
      function Harness() {
        const [open, setOpen] = useState(true);
        const change = (next: boolean) => { onOpenChange(next); setOpen(next); };
        const body = (
          <div>
            <textarea data-testid="reason" defaultValue="반려 사유 쓰던 글" />
            <textarea data-testid="empty" defaultValue="" />
            <input data-testid="line" defaultValue="한 줄" />
          </div>
        );
        return (
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            {kind === 'Sheet'
              ? <Sheet open={open} onOpenChange={change}><SheetContent side="bottom"><SheetTitle>시트</SheetTitle>{body}</SheetContent></Sheet>
              : <Dialog open={open} onOpenChange={change}><DialogContent><DialogTitle>창</DialogTitle>{body}</DialogContent></Dialog>}
          </NextIntlClientProvider>
        );
      }
      await act(async () => { root.render(<Harness />); });
      // base-ui는 열린 뒤 한 틈 뒤(rAF · 타이머)에 첫 초점을 팝업 안 첫 칸으로 옮긴다 — 그 뒤에 칸을 고르고 Esc를 눌러야 실제 사용 순서와 같다
      // (부하 아래에서 첫 초점이 Esc 뒤에 와서 초점을 칸으로 되돌리던 흔들림 · 러너 대조 판에서 봄).
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    }

    it('② 글 있는 여러 줄 칸: 첫 Esc = 칸에서만(안 닫힘 · 글 그대로 · 초점이 칸을 떠남) · 둘째 Esc = 닫힘', async () => {
      await mount();
      const reason = q('reason')!;
      await act(async () => { reason.focus(); });
      await act(async () => { esc(reason); });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(q('reason')?.value).toBe('반려 사유 쓰던 글');
      expect(document.activeElement).not.toBe(q('reason'));
      await act(async () => { esc(document.activeElement ?? document.body); });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('① 조합 중 Esc = 안 닫힘 · 초점 칸 그대로', async () => {
      await mount();
      const reason = q('reason')!;
      await act(async () => { reason.focus(); });
      await act(async () => { esc(reason, { isComposing: true }); });
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(q('reason'));
    });

    it('③ 빈 여러 줄 칸 · 한 줄 칸 = 한 번에 닫힘', async () => {
      for (const id of ['empty', 'line']) {
        await mount();
        const el = q(id)!;
        await act(async () => { el.focus(); });
        await act(async () => { esc(el); });
        expect(onOpenChange, id).toHaveBeenCalledWith(false);
        await act(async () => { root.unmount(); });
        root = createRoot(container);
      }
    });
  });
}
