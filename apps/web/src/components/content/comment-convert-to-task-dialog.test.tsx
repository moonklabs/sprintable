// @vitest-environment jsdom
//
// story #3517(유나 §22-④) — 「작업으로 전환」 다이얼로그. 제목 prefill(댓글 본문은
// 제목에 안 실림·다이얼로그 안에 댓글을 별도로 보여줌), 성공 시 인라인 링크(#3503
// FollowUpDialog와 동형 패턴). Dialog는 document.body에 포탈되므로(로컬 container
// 밖) 전부 document.querySelector로 찾는다 — insights-board/page.test.tsx의 follow-up
// 다이얼로그 테스트와 동형 관례.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentConvertToTaskDialog } from './comment-convert-to-task-dialog';
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
  id: 'c1',
  authorDisplayName: '홍길동',
  bodyText: '이 부분 설명이 부족해요',
  externalCreatedAt: '2026-09-05T10:00:00Z',
  deletedAt: null,
  replyStatus: 'none',
};

describe('CommentConvertToTaskDialog', () => {
  it('제목이 「[댓글] {게시물 제목}」으로 prefill되고, 댓글 본문은 제목에 없다', async () => {
    await act(async () => {
      root.render(wrap(<CommentConvertToTaskDialog postTitle="9월 소식지" comment={COMMENT} onClose={vi.fn()} onSubmit={vi.fn()} />));
    });
    const titleInput = document.querySelector('#comments-convert-title') as HTMLInputElement;
    expect(titleInput.value).toBe('[댓글] 9월 소식지');
    expect(titleInput.value).not.toContain(COMMENT.bodyText);
  });

  it('다이얼로그 안에 대상 댓글 본문을 별도로 보여준다', async () => {
    await act(async () => {
      root.render(wrap(<CommentConvertToTaskDialog postTitle="9월 소식지" comment={COMMENT} onClose={vi.fn()} onSubmit={vi.fn()} />));
    });
    expect(document.querySelector('[data-testid="comment-body-text"]')?.textContent).toContain(COMMENT.bodyText);
  });

  it('제출 성공 — 인라인 성공 문구+story 링크(전체 페이지 리다이렉트 없음)', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true, storyId: 's-42' });
    await act(async () => {
      root.render(wrap(<CommentConvertToTaskDialog postTitle="9월 소식지" comment={COMMENT} onClose={vi.fn()} onSubmit={onSubmit} />));
    });
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.type === 'submit') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    expect(onSubmit).toHaveBeenCalledWith({ title: '[댓글] 9월 소식지', note: '' });
    const link = document.querySelector('[data-testid="comments-convert-success-link"]') as HTMLAnchorElement;
    expect(link?.getAttribute('href')).toBe('/board?story=s-42');
  });

  it('제출 실패 — 에러 문구가 뜨고 폼은 그대로 남는다', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, errorMessage: '오류가 발생했습니다.' });
    await act(async () => {
      root.render(wrap(<CommentConvertToTaskDialog postTitle="9월 소식지" comment={COMMENT} onClose={vi.fn()} onSubmit={onSubmit} />));
    });
    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.type === 'submit') as HTMLButtonElement;
    await act(async () => { submitBtn.click(); });
    expect(document.querySelector('[data-testid="comments-convert-error"]')?.textContent).toBe('오류가 발생했습니다.');
    expect(document.querySelector('#comments-convert-title')).not.toBeNull();
  });
});
