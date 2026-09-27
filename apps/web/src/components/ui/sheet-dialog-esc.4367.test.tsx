// @vitest-environment jsdom
//
// [SID:4367] 한 Esc = 한 층 — base-ui 시트 · 창(Dialog 원형)의 Esc 닫기가 안쪽 층이 쓴 Esc를 건너뜀(유나 CR · PR 4749 · comment 5860172394).
// lg 미만 작업 목록 상세는 Sheet(work-list-shell.tsx)라, 그 안 산출물 댓글 쓰기 칸 Esc가 칸을 닫고도 시트까지 닫아 행 선택이 지워졌다.
// 여기선 실제 Sheet · Dialog(ui 원형) 안에 실제 댓글 쓰기 칸을 두고 잰다 — 칸 Esc → 칸만 닫힘 · 시트/창 그대로(onOpenChange 0) ·
// 표시 없는 Esc(팝업 위) → 닫힘(양성 대조).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { Sheet, SheetContent, SheetTitle } from './sheet';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { CommentComposePopover } from '@/components/canvas/comment-compose-popover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const esc = (t: EventTarget) => t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

for (const kind of ['Sheet', 'Dialog'] as const) {
  describe(`${kind} — 안쪽이 쓴 Esc는 안 닫힘([SID:4367])`, () => {
    it('댓글 쓰기 칸 Esc → 칸만 닫힘 · 그대로 열림 → 팝업 위 Esc → 닫힘', async () => {
      const onOpenChange = vi.fn();
      const onCancel = vi.fn();
      function Harness() {
        const [open, setOpen] = useState(true);
        const [compose, setCompose] = useState(true);
        const change = (next: boolean) => { onOpenChange(next); setOpen(next); };
        const inner = (
          <div data-testid="body">
            {compose ? <CommentComposePopover onSubmit={() => {}} onCancel={() => { onCancel(); setCompose(false); }} /> : <button type="button" data-testid="plain">plain</button>}
          </div>
        );
        return (
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            {kind === 'Sheet'
              ? <Sheet open={open} onOpenChange={change}><SheetContent side="bottom"><SheetTitle>시트</SheetTitle>{inner}</SheetContent></Sheet>
              : <Dialog open={open} onOpenChange={change}><DialogContent><DialogTitle>창</DialogTitle>{inner}</DialogContent></Dialog>}
          </NextIntlClientProvider>
        );
      }
      await act(async () => { root.render(<Harness />); });
      await act(async () => { await Promise.resolve(); });
      const ta = document.body.querySelector('[data-testid="body"] textarea') as HTMLTextAreaElement;
      expect(ta).not.toBeNull();
      await act(async () => { esc(ta); });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(document.body.querySelector('[data-testid="body"]')).not.toBeNull();
      await act(async () => { esc(document.body.querySelector('[data-testid="plain"]')!); });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
}
