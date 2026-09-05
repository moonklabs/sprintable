// @vitest-environment jsdom
//
// story #3517(유나 §22-④) — 댓글 답변 상태 6종 칩. status-chip.tsx와 같은 톤 체계
// 재사용 확인(tint 배경 위 text-foreground 규율, #2534/#2932 교훈 재확인).
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentReplyStatusChip } from './comment-reply-status-chip';
import type { CommentReplyStatus } from './comment-reply-status';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const STATUSES: { status: CommentReplyStatus; label: string; tint: boolean }[] = [
  { status: 'none', label: '무응답', tint: false },
  { status: 'draft', label: '초안', tint: false },
  { status: 'submitted', label: '상신됨', tint: true },
  { status: 'approved', label: '승인됨', tint: true },
  { status: 'published', label: '발행됨', tint: true },
  { status: 'failed', label: '실패', tint: true },
];

describe('CommentReplyStatusChip — 6상태 전부', () => {
  for (const { status, label, tint } of STATUSES) {
    it(`${status} — 라벨 "${label}"·${tint ? 'tint 배경 위 text-foreground' : 'muted 톤'}`, async () => {
      const { container, root } = mount();
      await act(async () => { root.render(wrap(<CommentReplyStatusChip status={status} />)); });
      const chip = container.querySelector(`[data-comment-reply-status-chip="${status}"]`);
      expect(chip?.textContent).toBe(label);
      if (tint) {
        expect(chip?.className).toContain('text-foreground');
        expect(chip?.className).toMatch(/bg-\S+-tint/);
      } else {
        expect(chip?.className).toContain('text-muted-foreground');
      }
    });
  }
});
