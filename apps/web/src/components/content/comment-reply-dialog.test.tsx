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
  replyExternalUrl: null, replyFailureAction: undefined, replyCommandId: null, replyId: null,
  latestReplyText: null, repliesCount: 0,
  openReplyDraft: null, sentRepliesCount: 0,
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

  // story #3596(유나 §22-16 ⑦, 페드루 PO 追加 2026-09-07, AC8 마지막 조각) —
  // 「대상 댓글」 블록에 이미 보낸 답변 수(sentRepliesCount, 목록이 이미 실어
  // 준 값)를 한 줄로. 0이면 안 그린다. 뮤테이션 대상(이 줄 자체를 지우면 RED).
  it('sentRepliesCount>0이면 「이미 보낸 답변 N건」 한 줄, 0이면 그 줄이 없다', async () => {
    await act(async () => {
      root.render(wrap(<CommentReplyDialog comment={{ ...COMMENT, sentRepliesCount: 1 }} onClose={vi.fn()} onCreateDraft={vi.fn()} onSubmit={vi.fn()} />));
    });
    expect(document.querySelector('[data-testid="comments-reply-already-sent-count"]')?.textContent).toBe('이 댓글에 이미 보낸 답변 1건');
  });

  it('sentRepliesCount===0이면 「이미 보낸 답변」 줄이 없다', async () => {
    await act(async () => {
      root.render(wrap(<CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={vi.fn()} onSubmit={vi.fn()} />));
    });
    expect(document.querySelector('[data-testid="comments-reply-already-sent-count"]')).toBeNull();
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

  // story #3596(AC2·AC7·AC11) — 「이어서 답변」이 여는 자리. 목록 GET이 이미
  // 실어 준 initialDraft{id,text}로 create 단계를 완전히 건너뛴다(같은 댓글에
  // 새 초안을 만들면 서버가 409를 낸다 — onCreateDraft 자체를 부를 필요가
  // 없다). 뮤테이션 대상③(채움 제거 — initialDraft를 안 쓰면 이 테스트가
  // 빈 create 폼을 보게 돼 RED).
  it('initialDraft가 있으면 create 단계 없이 곧장 draft 뷰가 채워져 뜬다', async () => {
    const onCreateDraft = vi.fn<() => Promise<CommentReplyOutcome>>();
    const onSubmit = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({ ok: true, reply: { ...DRAFT_REPLY, status: 'pending', target_comment_state: 'current' } });
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog
          comment={COMMENT} onClose={vi.fn()} onCreateDraft={onCreateDraft} onSubmit={onSubmit}
          initialDraft={{ id: 'r-existing', text: '작성하던 답변' }}
        />,
      ));
    });
    // create 폼(텍스트 입력·임시저장 버튼) 자체가 없다 — 곧장 상신 버튼.
    expect(document.querySelector('#comments-reply-text')).toBeNull();
    expect(document.querySelector('[data-testid="comments-reply-draft-prefill-fetch-failed"]')).toBeNull();
    expect(document.body.textContent).toContain('작성하던 답변');
    await act(async () => { (document.querySelector('[data-testid="comments-reply-submit-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(onCreateDraft).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith('r-existing');
  });

  // story #3596(페드루 PO 追加 2026-09-07) — 레이스: 목록은 초안이 없다고 봤지만
  // (일반 「답변」로 빈 create 폼을 연 채) 다른 세션이 먼저 초안을 만들어 create가
  // 409+existingReplyId로 막힌다. 재시도로 우회하지 않고 그 초안 원문을 단건
  // GET(AC11 재사용)으로 채워 이어간다 — 뮤테이션 대상②(409 갈래 제거 — RED).
  it('create가 409+existingReplyId를 돌려주면 그 초안 원문을 단건 GET으로 채워 이어간다', async () => {
    const onCreateDraft = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({
      ok: false, errorMessage: '안 보낸 초안이 이미 있습니다.', existingReplyId: 'r-race',
    });
    const onFetchReplyText = vi.fn<(replyId: string) => Promise<string | undefined>>().mockResolvedValue('레이스로 먼저 생긴 초안');
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={onCreateDraft} onSubmit={vi.fn()} onFetchReplyText={onFetchReplyText} />,
      ));
    });
    await act(async () => { setValue(document.querySelector('#comments-reply-text') as HTMLTextAreaElement, '내가 막 쓰던 것'); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(onFetchReplyText).toHaveBeenCalledWith('r-race');
    // 409 자체는 에러 배너가 아니라 draft 뷰 전환으로 흡수된다 — 에러 문구 없음.
    expect(document.querySelector('[data-testid="comments-reply-error"]')).toBeNull();
    expect(document.querySelector('[data-testid="comments-reply-draft-prefill-fetch-failed"]')).toBeNull();
    expect(document.body.textContent).toContain('레이스로 먼저 생긴 초안');
    expect(document.querySelector('[data-testid="comments-reply-submit-button"]')).not.toBeNull();
  });

  // 위 레이스 복구의 단건 GET 자체가 실패하면(신규 문구, voided 「다시 상신」과
  // 재사용 0) commentsReplyDraftPrefillFetchFailed로 안전 폴백한다 — 원문을
  // 못 보여줘도 상신은 그대로 가능(서버가 이미 갖고 있는 그 초안을 상신할
  // 뿐이라 로컬 표시 실패가 그 능력 자체를 막지 않는다).
  it('레이스 복구의 단건 GET이 실패하면 commentsReplyDraftPrefillFetchFailed로 폴백한다', async () => {
    const onCreateDraft = vi.fn<() => Promise<CommentReplyOutcome>>().mockResolvedValue({
      ok: false, errorMessage: '안 보낸 초안이 이미 있습니다.', existingReplyId: 'r-race',
    });
    const onFetchReplyText = vi.fn<(replyId: string) => Promise<string | undefined>>().mockResolvedValue(undefined);
    await act(async () => {
      root.render(wrap(
        <CommentReplyDialog comment={COMMENT} onClose={vi.fn()} onCreateDraft={onCreateDraft} onSubmit={vi.fn()} onFetchReplyText={onFetchReplyText} />,
      ));
    });
    await act(async () => { setValue(document.querySelector('#comments-reply-text') as HTMLTextAreaElement, '내가 막 쓰던 것'); });
    await act(async () => { (document.querySelector('[data-testid="comments-reply-draft-button"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(document.querySelector('[data-testid="comments-reply-draft-prefill-fetch-failed"]')?.textContent).toBe('작성한 답변을 불러오지 못했습니다 — 저장된 내용 그대로 상신됩니다.');
    // story #3596(유나 Design CHANGES② 2026-09-07) — 읽기 전용 자리라 빈 상자를
    // 그리면 「초안이 비었다」로 읽힌다 — 실패 시 상자 자체를 안 그린다.
    expect(document.querySelector('[data-testid="comments-reply-draft-text-box"]')).toBeNull();
    expect(document.querySelector('[data-testid="comments-reply-submit-button"]')).not.toBeNull();
  });
});
