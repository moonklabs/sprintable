// @vitest-environment jsdom
//
// story #3517(유나 §22-⑤, BE #3867 조각②) — 답변 초안→상신 다이얼로그. 성공 시
// 봉인 셋(답변 본문·대상 댓글은 상단에 항상 표시·target_comment_state 문장) 렌더,
// 오류 문구 그대로 표시.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentReplyDialog, type CommentReplyOutcome, type ReplyView } from './comment-reply-dialog';
import type { CommentItem } from './comments-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const COMMENT: CommentItem = {
  id: 'c1', authorDisplayName: '홍길동', bodyText: '언제 재입고되나요?',
  externalCreatedAt: '2026-09-05T10:00:00Z', capturedAt: '2026-09-05T10:00:00Z', deletedAt: null, replyStatus: 'none',
};

const DRAFT_REPLY: ReplyView = {
  id: 'r1', comment_id: 'c1', text: '다음 주 월요일에 재입고됩니다', status: 'draft', gate_id: null,
  external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: null,
};

function setValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CommentReplyDialog', () => {
  it('대상 댓글이 항상 상단에 보인다(§22-③)', async () => {
    await act(async () => {
      root.render(wrap(<CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={vi.fn()} onSubmit={vi.fn()} />));
    });
    expect(document.body.textContent).toContain('언제 재입고되나요?');
  });

  it('초안 저장 — onCreateDraft에 입력한 텍스트가 전달되고, 성공하면 초안 화면으로 전환된다', async () => {
    const onCreateDraft = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: DRAFT_REPLY });
    await act(async () => {
      root.render(wrap(<CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={onCreateDraft} onSubmit={vi.fn()} />));
    });
    const textarea = document.querySelector('#comments-reply-text') as HTMLTextAreaElement;
    await act(async () => { setValue(textarea, '다음 주 월요일에 재입고됩니다'); });
    const draftBtn = document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement;
    await act(async () => { draftBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(onCreateDraft).toHaveBeenCalledWith('다음 주 월요일에 재입고됩니다');
    expect(document.querySelector('[data-testid="comments-reply-submit-button"]')).not.toBeNull();
    expect(document.body.textContent).toContain('다음 주 월요일에 재입고됩니다');
  });

  it('초안 저장 실패 — 에러 문구가 뜨고 입력 화면에 그대로 남는다', async () => {
    const onCreateDraft = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: false, errorMessage: '댓글을 찾을 수 없습니다' });
    await act(async () => {
      root.render(wrap(<CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={onCreateDraft} onSubmit={vi.fn()} />));
    });
    const textarea = document.querySelector('#comments-reply-text') as HTMLTextAreaElement;
    await act(async () => { setValue(textarea, '답변 내용'); });
    const draftBtn = document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement;
    await act(async () => { draftBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-testid="comments-reply-error"]')?.textContent).toBe('댓글을 찾을 수 없습니다');
    expect(document.querySelector('#comments-reply-text')).not.toBeNull();
  });

  it('상신 성공(target_comment_state=current) — 성공 문구+봉인 텍스트만 뜨고 changed/deleted 안내는 없다', async () => {
    const submitted: ReplyView = { ...DRAFT_REPLY, status: 'pending', target_comment_state: 'current' };
    const onSubmit = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: submitted });
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog
          comment={COMMENT}
          onClose={vi.fn()}
          onCreateDraft={vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: DRAFT_REPLY })}
          onSubmit={onSubmit}
        />,
      ));
    });
    const textarea = document.querySelector('#comments-reply-text') as HTMLTextAreaElement;
    await act(async () => { setValue(textarea, '다음 주 월요일에 재입고됩니다'); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });

    expect(onSubmit).toHaveBeenCalledWith('r1');
    expect(document.querySelector('[data-testid="comments-reply-sealed-text"]')?.textContent).toBe('다음 주 월요일에 재입고됩니다');
    expect(document.querySelector('[data-testid="comments-reply-target-changed"]')).toBeNull();
    expect(document.querySelector('[data-testid="comments-reply-target-deleted"]')).toBeNull();
  });

  it('상신 성공(target_comment_state=changed) — 변경 안내가 뜬다(승인은 가능)', async () => {
    const submitted: ReplyView = { ...DRAFT_REPLY, status: 'pending', target_comment_state: 'changed' };
    const onSubmit = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: submitted });
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog
          comment={COMMENT}
          onClose={vi.fn()}
          onCreateDraft={vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: DRAFT_REPLY })}
          onSubmit={onSubmit}
        />,
      ));
    });
    await act(async () => { setValue(document.querySelector('#comments-reply-text') as HTMLTextAreaElement, 'x'); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-testid="comments-reply-target-changed"]')?.textContent).toBe('대상 댓글 본문이 상신 이후 바뀌었습니다. 승인은 가능합니다.');
  });

  it('상신 실패(409 대상 삭제) — 에러 문구가 뜬다', async () => {
    const onSubmit = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: false, errorMessage: '답변 대상 댓글이 삭제되어 상신할 수 없습니다.' });
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog
          comment={COMMENT}
          onClose={vi.fn()}
          onCreateDraft={vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: DRAFT_REPLY })}
          onSubmit={onSubmit}
        />,
      ));
    });
    await act(async () => { setValue(document.querySelector('#comments-reply-text') as HTMLTextAreaElement, 'x'); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-testid="comments-reply-error"]')?.textContent).toBe('답변 대상 댓글이 삭제되어 상신할 수 없습니다.');
  });
});
