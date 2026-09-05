// @vitest-environment jsdom
//
// story #3517(유나 §22-②·④) — 세 얼굴(미수집/댓글없음/불러오지못함/목록) + 댓글 행마다
// 답변 상태 6종 진리표. AC1(세 얼굴 구분)·AC5(채널 분기 0, 값은 서버 응답 그대로).
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentsSection, type CommentItem, type CommentsFace } from './comments-section';
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

const TZ = 'Asia/Seoul';

function baseComment(overrides: Partial<CommentItem>): CommentItem {
  return {
    id: 'c1',
    authorDisplayName: '홍길동',
    bodyText: '좋은 글이네요',
    externalCreatedAt: '2026-09-05T10:00:00Z',
    replyStatus: 'none',
    ...overrides,
  };
}

describe('CommentsSection — 세 얼굴(story #3517 §22-②)', () => {
  it('uncollected(null) — "아직 수집 전"만 뜨고 목록·수집시각은 안 뜬다', async () => {
    const face: CommentsFace = { kind: 'uncollected' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
    expect(container.querySelector('[data-testid="comments-face-uncollected"]')?.textContent).toBe('아직 수집 전입니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-item"]')).toBeNull();
  });

  it('error(fetch 실패) — "불러오지 못했습니다"만 뜬다(0건과 다른 문구)', async () => {
    const face: CommentsFace = { kind: 'error' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
    expect(container.querySelector('[data-testid="comments-face-error"]')?.textContent).toBe('댓글을 불러오지 못했습니다.');
  });

  it('empty([]) — "댓글이 없습니다"+수집시각(uncollected/error와 다른 문구·표시)', async () => {
    const face: CommentsFace = { kind: 'empty', capturedAt: '2026-09-05T10:00:00Z' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
    expect(container.querySelector('[data-testid="comments-face-empty"]')?.textContent).toBe('댓글이 없습니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')?.textContent).toContain('09-05');
  });

  it('loaded(n건) — 목록·수집시각 모두 뜬다', async () => {
    const face: CommentsFace = { kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', comments: [baseComment({})] };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
    expect(container.querySelectorAll('[data-testid="comments-item"]').length).toBe(1);
    expect(container.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe('홍길동');
  });

  it('작성자 표시명이 없으면(null) 지어내지 않고 "모름" 폴백', async () => {
    const face: CommentsFace = { kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', comments: [baseComment({ authorDisplayName: null })] };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
    expect(container.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe(koMessages.content.originAuthorUnknown);
  });
});

describe('CommentsSection — 답변 상태 6종 × 행 액션(story #3517 §22-④)', () => {
  const STATUSES: CommentReplyStatus[] = ['none', 'draft', 'submitted', 'approved', 'published', 'failed'];

  for (const status of STATUSES) {
    it(`replyStatus=${status} — 그 댓글 행에 해당 칩이 선다`, async () => {
      const face: CommentsFace = { kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', comments: [baseComment({ replyStatus: status })] };
      const { container, root } = mount();
      await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={vi.fn()} />)); });
      expect(container.querySelector(`[data-comment-reply-status-chip="${status}"]`)).not.toBeNull();
    });
  }

  it('「작업으로 전환」 클릭 — 그 댓글 객체 그대로 콜백에 전달', async () => {
    const comment = baseComment({});
    const onConvertToTask = vi.fn();
    const face: CommentsFace = { kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', comments: [comment] };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={onConvertToTask} onReply={vi.fn()} />)); });
    const btn = container.querySelector('[data-testid="comments-item-convert-to-task"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onConvertToTask).toHaveBeenCalledWith(comment);
  });

  it('「답변」 클릭 — 그 댓글 객체 그대로 콜백에 전달', async () => {
    const comment = baseComment({});
    const onReply = vi.fn();
    const face: CommentsFace = { kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', comments: [comment] };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onConvertToTask={vi.fn()} onReply={onReply} />)); });
    const btn = container.querySelector('[data-testid="comments-item-reply"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onReply).toHaveBeenCalledWith(comment);
  });
});
