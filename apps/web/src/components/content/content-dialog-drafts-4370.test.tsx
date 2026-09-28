// @vitest-environment jsdom
/**
 * story #4370 — 발행물 댓글 · 인사이트 창의 여러 줄 칸 폼 초안(유나 판정 (가): 여러 줄 칸이 든 폼은 폼 전체가 대상별 초안 하나):
 * - 댓글 → 할 일 전환(제목 · 메모 · 댓글 키) · 댓글 답글(서버 초안 만들기 전 글 · 댓글 키) · 인사이트 후속(유형 · 제목 · 메모 · 발행물 키).
 * 부모가 창을 조건부 마운트하므로 닫힘 = 언마운트 — 다시 열면(재마운트) 그대로 · 보이는 «취소»와 성공에서만 지운다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { CommentItem } from './comments-section';
import { CommentConvertToTaskDialog } from './comment-convert-to-task-dialog';
import { CommentReplyDialog } from './comment-reply-dialog';
import { FollowUpDialog } from '@/components/insights-board/follow-up-dialog';

vi.mock('@/hooks/use-flat-href', () => ({ useFlatHref: () => (p: string) => p }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const content = koMessages.content as Record<string, string>;
const insights = koMessages.insightsBoard as Record<string, string>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const COMMENT = {
  id: 'c-1', authorDisplayName: '독자', bodyText: '좋은 글이에요', externalCreatedAt: null, capturedAt: '2026-09-27T00:00:00Z', deletedAt: null,
} as unknown as CommentItem;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); };
const textarea = () => document.body.querySelector<HTMLTextAreaElement>('textarea');
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === label)!;
async function render(node: ReactNode | null) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>); });
  await settle();
}
async function type(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('댓글 → 할 일 전환 창 폼 초안(story #4370)', () => {
  let ok = true;
  const dialog = () => (
    <CommentConvertToTaskDialog
      postTitle="가을 캠페인" comment={COMMENT} onClose={() => {}}
      onSubmit={async () => (ok ? { ok: true, storyId: 's-9' } : { ok: false, errorMessage: '실패' })}
    />
  );
  it('닫았다 열면 메모가 남고 · «취소»는 지우고 · 성공은 지운다', async () => {
    ok = true;
    await render(dialog());
    await type(textarea()!, '할 일 메모');
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('할 일 메모');
    await act(async () => { button(content.commentsConvertCancel).click(); });
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('');
    await type(textarea()!, '만들 메모');
    await act(async () => { button(content.commentsConvertSubmit).click(); });
    await settle();
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('');
  });
});

describe('댓글 답글 창 초안 — 서버 초안 만들기 전 글(story #4370)', () => {
  const dialog = () => (
    <CommentReplyDialog
      comment={COMMENT} onClose={() => {}}
      onCreateDraft={async (text) => ({ ok: true, reply: { id: 'r-1', comment_id: 'c-1', text, status: 'draft', gate_id: null, external_reply_id: null } as never })}
      onSubmit={async () => ({ ok: false, errorMessage: 'x' })}
    />
  );
  it('닫았다 열면 쓰던 답글이 남고 · 서버 초안 만들기 성공이면 로컬 초안은 지운다', async () => {
    await render(dialog());
    await type(textarea()!, '감사합니다!');
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('감사합니다!');
    await act(async () => { button(content.commentsReplySaveDraftCta).click(); });
    await settle();
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('');
  });
});

describe('인사이트 후속 창 폼 초안(story #4370)', () => {
  const dialog = () => <FollowUpDialog orgId="org-1" publicationId="pub-1" originalTitle="가을 캠페인" onClose={() => {}} />;
  it('닫았다 열면 메모가 남고 · «취소»는 지운다 · 만들기 성공은 지운다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ data: { story_id: 's-1' } }) })));
    await render(dialog());
    await type(textarea()!, '다시 올릴 때 시간대 바꾸기');
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('다시 올릴 때 시간대 바꾸기');
    await act(async () => { button(insights.followUpCancel).click(); });
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('');
    await type(textarea()!, '만들 메모');
    await act(async () => { button(insights.followUpSubmit).click(); });
    await settle();
    await render(null);
    await render(dialog());
    expect(textarea()!.value).toBe('');
  });
});
