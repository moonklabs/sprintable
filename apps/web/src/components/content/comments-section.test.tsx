// @vitest-environment jsdom
//
// story #3517(유나 §22-②·④·⑨) — 세 얼굴(미수집/댓글없음/불러오지못함/목록) + 댓글
// 행마다 답변 상태 6종 진리표 + 지워진 댓글(§22-9) 처리.
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentsSection, deriveCommentsFace, type CommentItem, type CommentsFace, type RawCommentsResponse } from './comments-section';

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
    capturedAt: '2026-09-05T10:30:00Z',
    deletedAt: null,
    replyStatus: 'none',
    replyExternalUrl: null,
    replyFailureAction: undefined,
    replyCommandId: null,
    ...overrides,
  };
}

function loadedFace(comments: CommentItem[], overrides: Partial<Extract<CommentsFace, { kind: 'loaded' }>> = {}): CommentsFace {
  return {
    kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z',
    comments, activeCount: comments.filter((c) => !c.deletedAt).length, deletedCount: comments.filter((c) => c.deletedAt).length,
    nextAllowedAt: null,
    ...overrides,
  };
}

function emptyFace(comments: CommentItem[], overrides: Partial<Extract<CommentsFace, { kind: 'empty' }>> = {}): CommentsFace {
  return {
    kind: 'empty', capturedAt: '2026-09-05T10:00:00Z',
    comments, activeCount: comments.filter((c) => !c.deletedAt).length, deletedCount: comments.filter((c) => c.deletedAt).length,
    nextAllowedAt: null,
    ...overrides,
  };
}

describe('CommentsSection — 세 얼굴(story #3517 §22-②)', () => {
  it('uncollected(null) — "아직 수집 전"만 뜨고 목록·수집시각은 안 뜬다', async () => {
    const face: CommentsFace = { kind: 'uncollected' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-face-uncollected"]')?.textContent).toBe('아직 수집 전입니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-item"]')).toBeNull();
  });

  it('error(fetch 실패) — "불러오지 못했습니다"만 뜬다(0건과 다른 문구)', async () => {
    const face: CommentsFace = { kind: 'error' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-face-error"]')?.textContent).toBe('댓글을 불러오지 못했습니다.');
  });

  it('empty([]) — "댓글이 없습니다"+수집시각+제목에 0건(uncollected/error와 다른 문구·표시)', async () => {
    const face: CommentsFace = { kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', comments: [], activeCount: 0, deletedCount: 0, nextAllowedAt: null };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-face-empty"]')?.textContent).toBe('댓글이 없습니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')?.textContent).toContain('09-05');
    expect(container.querySelector('h3')?.textContent).toBe('댓글 0');
  });

  it('loaded(n건) — 목록·수집시각·제목의 카운트 모두 뜬다', async () => {
    const face = loadedFace([baseComment({})]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelectorAll('[data-testid="comments-item"]').length).toBe(1);
    expect(container.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe('홍길동');
    expect(container.querySelector('h3')?.textContent).toBe('댓글 1');
  });

  // story #3517(BE #3865 REQUIRED 2, PO 確定) — 제목의 카운트는 activeCount(서버
  // 전체 수)를 쓴다 — 이 페이지에 실린 comments.length(offset/limit로 잘린 값)로
  // 세면 페이지가 넘어갈 때마다 숫자가 틀린다.
  it('activeCount는 서버 전체 수를 쓴다(이 페이지의 comments.length가 아니다)', async () => {
    const face = loadedFace([baseComment({})], { activeCount: 42 });
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('h3')?.textContent).toBe('댓글 42');
  });

  // story #3517(유나 §22-10②, PO 確定 2026-09-05) — 작성자 없으면 이 화면 전용
  // 문구("작성자 정보 없음")를 쓴다(공유 「모름」이 아니다 — 구체적으로 뭘 못
  // 받았는지 말한다).
  it('작성자 표시명이 없으면(null) "작성자 정보 없음"(공유 「모름」이 아니다)', async () => {
    const face = loadedFace([baseComment({ authorDisplayName: null })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe('작성자 정보 없음');
  });

  it('externalCreatedAt이 있으면 그 값을 그대로 보인다(작성 시각)', async () => {
    const face = loadedFace([baseComment({ externalCreatedAt: '2026-09-05T09:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-authored-at"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="comments-item-captured-at"]')).toBeNull();
  });

  // story #3517(유나 §22-10②) — external_created_at이 없으면 capturedAt으로
  // 폴백하되 라벨을 "작성"이 아니라 "수집"으로 바꾼다(captured_at을 작성 시각으로
  // 적으면 거짓말 — 우리가 발견한 시각일 뿐이다).
  it('externalCreatedAt이 null이면 capturedAt+"수집" 라벨로 폴백한다(지어내지 않되 자리를 비우지 않는다)', async () => {
    const face = loadedFace([baseComment({ externalCreatedAt: null, capturedAt: '2026-09-05T10:30:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-authored-at"]')).toBeNull();
    const capturedSpan = container.querySelector('[data-testid="comments-item-captured-at"]');
    expect(capturedSpan?.textContent).toContain('수집');
  });
});

// story #3517(유나 §22-9, BE #3865 REQUIRED 2, PO 確定 2026-09-05) — 지워진 댓글.
describe('CommentsSection — 지워진 댓글(story #3517 §22-9)', () => {
  it('deletedAt이 있으면 목록에서 안 빠지고 "원본이 지워졌습니다" 안내가 뜬다', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelectorAll('[data-testid="comments-item"]').length).toBe(1);
    expect(container.querySelector('[data-testid="comments-item-deleted-note"]')?.textContent).toBe('원본이 지워졌습니다.');
  });

  // story #3517(PO 지정 순서, 2026-09-05) — §22-9 문장 순서: 사유가 위, 본문이 아래.
  it('사유("원본이 지워졌습니다")가 본문(comment-body-text)보다 DOM에서 먼저 온다', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    const item = container.querySelector('[data-testid="comments-item"]')!;
    const note = item.querySelector('[data-testid="comments-item-deleted-note"]')!;
    const body = item.querySelector('[data-testid="comment-body-text"]')!;
    expect(note.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('deletedAt이 null이면 지워짐 안내가 안 뜬다(회귀 0)', async () => {
    const face = loadedFace([baseComment({ deletedAt: null })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-deleted-note"]')).toBeNull();
  });

  // story #3517(유나 Design 재리뷰, 2026-09-05 실측) — active_count===0(empty 얼굴)
  // 이어도 지워진 행은 사라지면 안 된다("댓글 없음" 문구가 §22-9 "원래 자리 그대로"를
  // 지우는 결함이 있었다). PO 지정 표본: active 0·deleted 2.
  it('empty 얼굴(active 0)이어도 지워진 행 2개가 그대로 그려진다(§22-9 "댓글 없음"이 지워진 행을 지우지 않는다)', async () => {
    const face = emptyFace([
      baseComment({ id: 'c1', deletedAt: '2026-09-05T11:00:00Z' }),
      baseComment({ id: 'c2', deletedAt: '2026-09-05T11:05:00Z' }),
    ]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-face-empty"]')?.textContent).toBe('댓글이 없습니다.');
    expect(container.querySelectorAll('[data-testid="comments-item"]').length).toBe(2);
    expect(container.querySelectorAll('[data-testid="comments-item-deleted-note"]').length).toBe(2);
  });

  // story #3517(유나 Design 재리뷰, 2026-09-05 실측) — <summary>는 <details> 닫힘
  // 상태에서도 항상 보인다. 길이 기반 preview를 그대로 쓰면(200자 이하) preview===
  // 전문이라 "접혀도" 본문이 그대로 다 보이는 결함이 있었다 — textContent 단언은
  // <p>(펼쳤을 때 자리)까지 포함해 이 결함을 못 잡는다. 닫힌 상태에서 실제로 보이는
  // <summary> 자신의 텍스트만 따로 단언한다(기전이 아니라 표시).
  it('지워진 댓글은 짧아도 <summary>에 본문 문자열이 한 글자도 없다(닫힌 채 다 보이는 결함 회귀가드)', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z', bodyText: '짧은 글' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    const body = container.querySelector('[data-testid="comment-body-text"]');
    expect(body?.tagName).toBe('DETAILS');
    const summary = body?.querySelector('summary');
    expect(summary?.textContent).not.toContain('짧은 글');
    // 펼치면(<p>) 여전히 전문이 있다 — text는 보존돼 온다, 숨기는 게 아니다.
    const expandedBody = body?.querySelector('p');
    expect(expandedBody?.textContent).toContain('짧은 글');
  });

  // story #3517 조각②-b(PO 確定 2026-09-06) — 작업전환·답변 "액션"은 여전히 부재지만
  // 답변 상태 "칩"은 다른 축(이미 존재하는 답변의 생애주기)이라 지워진 댓글에도 그대로
  // 뜬다(위 CommentsList 주석 — 발행된 답변은 대상이 지워져도 발행된 채로 남는다).
  it('지워진 댓글엔 작업전환·답변 액션은 안 그려지지만(비활성이 아니라 부재) 답변 상태 칩은 그대로 뜬다', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-convert-to-task"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-item-reply"]')).toBeNull();
    expect(container.querySelector('[data-comment-reply-status-chip]')).not.toBeNull();
  });

  it('deletedCount>0이면 헤더에 "지워진 댓글 {n}건" 안내가 뜬다(서버 전체 수)', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })], { deletedCount: 3 });
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-deleted-count"]')?.textContent).toBe('지워진 댓글 3건');
  });

  it('deletedCount=0이면 그 안내 줄 자체가 안 뜬다', async () => {
    const face = loadedFace([baseComment({})], { deletedCount: 0 });
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-deleted-count"]')).toBeNull();
  });
});

// story #3517(BE #3867 조각②, PO 確定 2026-09-05) — 행 액션 재도입.
// story #3517 조각②-b(BE #3876, PO 確定 2026-09-06) — 답변 상태 칩 착지.
describe('CommentsSection — 행 액션(story #3517 조각②)', () => {
  it('지워지지 않은 댓글엔 작업전환·답변 버튼과 답변 상태 칩이 함께 뜬다', async () => {
    const face = loadedFace([baseComment({})]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-convert-to-task"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="comments-item-reply"]')).not.toBeNull();
    expect(container.querySelector('[data-comment-reply-status-chip]')?.getAttribute('data-comment-reply-status-chip')).toBe('none');
  });

  // story #3517 조각②-b — replyStatus='published'·replyExternalUrl 있으면 링크가
  // 뜬다. 다른 상태(예: submitted)는 링크 자체가 없어야 한다(§17 "신호 없으면 안
  // 그린다" — sent 전엔 external_reply_url 자체가 항상 null).
  it('replyStatus="published"·replyExternalUrl 있으면 「채널에서 보기」 링크가 뜬다', async () => {
    const face = loadedFace([baseComment({ replyStatus: 'published', replyExternalUrl: 'https://example.com/p/1' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    const link = container.querySelector('[data-testid="comments-item-reply-external-link"]') as HTMLAnchorElement;
    expect(link?.getAttribute('href')).toBe('https://example.com/p/1');
    expect(link?.textContent).toBe('채널에서 보기');
  });

  // story #3517 조각②-b(유나 §22-14④, PO 確定 2026-09-06) — replyStatus===null
  // (모르는 status)이면 칩 자리 자체를 안 그린다(지어내지 않는다).
  it('replyStatus=null(모르는 status)이면 답변 상태 칩 자리 자체가 안 뜬다', async () => {
    const face = loadedFace([baseComment({ replyStatus: null })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-reply-status"]')).toBeNull();
    expect(container.querySelector('[data-comment-reply-status-chip]')).toBeNull();
  });

  it('replyStatus="submitted"(발행 전)는 replyExternalUrl이 없어야 하고 링크도 안 뜬다', async () => {
    const face = loadedFace([baseComment({ replyStatus: 'submitted' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    expect(container.querySelector('[data-testid="comments-item-reply-external-link"]')).toBeNull();
  });

  it('「작업으로 전환」 클릭 — 그 댓글 객체 그대로 콜백에 전달된다', async () => {
    const comment = baseComment({});
    const onConvertToTask = vi.fn();
    const face = loadedFace([comment]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={onConvertToTask} onReply={() => {}} onRetryReply={async () => ({ ok: true })} />)); });
    const btn = container.querySelector('[data-testid="comments-item-convert-to-task"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onConvertToTask).toHaveBeenCalledWith(comment);
  });

  it('「답변」 클릭 — 그 댓글 객체 그대로 콜백에 전달된다', async () => {
    const comment = baseComment({});
    const onReply = vi.fn();
    const face = loadedFace([comment]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={onReply} onRetryReply={async () => ({ ok: true })} />)); });
    const btn = container.querySelector('[data-testid="comments-item-reply"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onReply).toHaveBeenCalledWith(comment);
  });
});

// story #3517(BE #3865 조각①, PO 確定 2026-09-05) — 원 응답(snake_case)→CommentsFace
// 매핑. 세 얼굴 판정이 이 함수 하나로만 결정되게(페이지가 직접 if/else로 판정하지
// 않는다) 단위테스트로 고정.
describe('deriveCommentsFace(story #3517, BE #3865/#3876 응답 매핑)', () => {
  function rawResponse(overrides: Partial<RawCommentsResponse>): RawCommentsResponse {
    return { last_collected_at: '2026-09-05T10:00:00Z', comments: [], active_count: 0, deleted_count: 0, ...overrides };
  }
  function rawComment(overrides: Partial<RawCommentsResponse['comments'][number]>): RawCommentsResponse['comments'][number] {
    return {
      id: 'c1', external_comment_id: 'ext-1', author_display_name: null, text: 'x',
      external_created_at: null, captured_at: 't', deleted_at: null, reply: null,
      ...overrides,
    };
  }

  it('last_collected_at=null → uncollected', () => {
    expect(deriveCommentsFace(rawResponse({ last_collected_at: null }))).toEqual({ kind: 'uncollected' });
  });

  it('active_count=0·deleted_count=0 → empty', () => {
    const face = deriveCommentsFace(rawResponse({}));
    expect(face).toEqual({ kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', comments: [], activeCount: 0, deletedCount: 0, nextAllowedAt: null });
  });

  it('active_count>0 → loaded, 필드명이 camelCase로 정확히 옮겨진다', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 1,
      comments: [rawComment({
        author_display_name: '홍길동', text: '본문', external_created_at: '2026-09-05T09:00:00Z', captured_at: '2026-09-05T10:00:00Z',
      })],
    }));
    expect(face).toEqual({
      kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', activeCount: 1, deletedCount: 0, nextAllowedAt: null,
      comments: [{
        id: 'c1', authorDisplayName: '홍길동', bodyText: '본문',
        externalCreatedAt: '2026-09-05T09:00:00Z', capturedAt: '2026-09-05T10:00:00Z', deletedAt: null,
        replyStatus: 'none', replyExternalUrl: null, replyFailureAction: undefined, replyCommandId: null,
      }],
    });
  });

  it('reply=null이면 replyStatus="none"(무응답, 지어내지 않는다)', () => {
    const face = deriveCommentsFace(rawResponse({ active_count: 1, comments: [rawComment({})] }));
    expect(face.kind).toBe('loaded');
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyStatus).toBe('none');
  });

  // 회귀가드 — reply 키 자체가 응답에서 생략되면(undefined, 구버전 픽스처·아직 이
  // 필드를 안 주는 소비처) 런타임에서 TS 타입("reply: {...} | null")을 강제 못 해
  // undefined가 그대로 온다. replyStatusFrom이 `=== null`만 검사하던 버전은 이
  // 자리에서 TypeError로 죽었다(page.test.tsx 6곳 실사고, 2026-09-06).
  it('reply 키 자체가 생략되면(undefined) 죽지 않고 replyStatus="none"', () => {
    const raw = rawResponse({
      active_count: 1,
      comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: null, text: 'x', external_created_at: null, captured_at: 't', deleted_at: null } as RawCommentsResponse['comments'][number]],
    });
    expect(() => deriveCommentsFace(raw)).not.toThrow();
    const face = deriveCommentsFace(raw);
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyStatus).toBe('none');
  });

  // story #3517 조각②-b(BE #3876, 유나 §22-13/§22-14, PO 確定 2026-09-06) — reply
  // summary 진리표. 무응답/초안/상신(승인 대기)/발송 대기(승인 뒤 워커 대기)/
  // 발행/실패 6종 전부 + 모르는 status는 칩 자체를 안 그린다(null).
  it.each([
    [null, 'none'],
    [{ id: 'r1', status: 'draft', external_reply_url: null, command_id: null, command_status: null, failure_kind: null, next_attempt_at: null, reason_code: null }, 'draft'],
    [{ id: 'r1', status: 'pending', external_reply_url: null, command_id: null, command_status: null, failure_kind: null, next_attempt_at: null, reason_code: null }, 'submitted'],
    [{ id: 'r1', status: 'pending', external_reply_url: null, command_id: 'cmd-1', command_status: 'pending', failure_kind: null, next_attempt_at: null, reason_code: null }, 'awaiting_send'],
    [{ id: 'r1', status: 'sent', external_reply_url: 'https://example.com/p/1', command_id: 'cmd-1', command_status: 'completed', failure_kind: null, next_attempt_at: null, reason_code: null }, 'published'],
    [{ id: 'r1', status: 'failed', external_reply_url: null, command_id: 'cmd-1', command_status: 'dead_letter', failure_kind: 'needs_check', next_attempt_at: null, reason_code: null }, 'failed'],
    [{ id: 'r1', status: 'some_future_status', external_reply_url: null, command_id: null, command_status: null, failure_kind: null, next_attempt_at: null, reason_code: null }, null],
  ] as const)('reply=%o → replyStatus=%s', (reply, expected) => {
    const face = deriveCommentsFace(rawResponse({ active_count: 1, comments: [rawComment({ reply })] }));
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyStatus).toBe(expected);
  });

  it('reply.status="sent"·external_reply_url 있으면 replyExternalUrl로 옮겨진다(발행 상태에서만 뜻이 있다)', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 1,
      comments: [rawComment({ reply: { id: 'r1', status: 'sent', external_reply_url: 'https://example.com/p/1', command_id: 'cmd-1', command_status: 'completed', failure_kind: null, next_attempt_at: null, reason_code: null } })],
    }));
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyExternalUrl).toBe('https://example.com/p/1');
  });

  it('comments_next_allowed_at이 있으면 nextAllowedAt으로 옮겨진다', () => {
    const face = deriveCommentsFace(rawResponse({ comments_next_allowed_at: '2026-09-05T10:05:00Z' }));
    expect((face as Extract<CommentsFace, { kind: 'empty' }>).nextAllowedAt).toBe('2026-09-05T10:05:00Z');
  });

  // story #3517(유나 §22-10①·⑨, PO 確定 2026-09-05 정정) — "댓글 없음" 판정은
  // active_count 하나만 본다. deleted_count>0(전부 지워짐)이어도 active_count=0이면
  // "댓글 없음" 얼굴이다 — deletedCount는 그 empty 얼굴 자체가 들고 있어(SectionHeader
  // 의 "지워진 댓글 {n}건" 안내) 지워진 사실 자체가 사라지진 않는다.
  it('active_count=0인데 deleted_count>0이면(전부 지워짐)도 empty이되, 지워진 행은 comments에 그대로 실린다(§22-9 "원래 자리")', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 0, deleted_count: 1,
      comments: [rawComment({ deleted_at: '2026-09-05T11:00:00Z' })],
    }));
    expect(face).toEqual({
      kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', activeCount: 0, deletedCount: 1, nextAllowedAt: null,
      comments: [{
        id: 'c1', authorDisplayName: null, bodyText: 'x',
        externalCreatedAt: null, capturedAt: 't', deletedAt: '2026-09-05T11:00:00Z',
        replyStatus: 'none', replyExternalUrl: null, replyFailureAction: undefined, replyCommandId: null,
      }],
    });
  });
});

// story #3544(3517 조각③, 유나 §22-15, PO 確定 2026-09-06) — 답변 「실패」 얼굴.
// 진리표는 «실재 조합»만(그라운딩 ②) — command_status×failure_kind×reason_code
// 이론상 조합이 아니라 _process_one_comment_reply_command가 실제로 대입하는
// 6종 + 모르는 값 1 + null(성공, 얼굴 자체가 없다) 1.
describe('CommentsSection — 답변 실패 얼굴(story #3544, 유나 §22-15)', () => {
  type RawReply = NonNullable<RawCommentsResponse['comments'][number]['reply']>;

  function rawComment(reply: RawReply | null): RawCommentsResponse['comments'][number] {
    return {
      id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: '언제 되나요?',
      external_created_at: '2026-09-05T10:00:00Z', captured_at: '2026-09-05T10:30:00Z', deleted_at: null,
      reply,
    };
  }

  function rawResponse(reply: RawReply | null): RawCommentsResponse {
    return { last_collected_at: '2026-09-05T10:00:00Z', comments: [rawComment(reply)], active_count: 1, deleted_count: 0 };
  }

  async function mountWithReply(reply: RawReply | null) {
    const face = deriveCommentsFace(rawResponse(reply));
    const { container, root } = mount();
    await act(async () => {
      root.render(wrap(
        <CommentsSection
          face={face} displayTimezone={TZ}
          onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}}
          onRetryReply={async () => ({ ok: true })}
        />,
      ));
    });
    return container;
  }

  const FAILED_BASE = { id: 'r1', status: 'failed', external_reply_url: null } as const;

  it.each([
    {
      name: '① pending+transient(+next_attempt_at) — 재시도 대기, 액션 없음',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'pending', failure_kind: 'transient', next_attempt_at: '2026-09-06T09:05:00Z', reason_code: null },
      expectedText: '보내지 못해 다시 시도합니다',
      hasAction: false,
    },
    {
      name: '① pending+transient, next_attempt_at 없음 — "곧" 문구로 접힌다',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'pending', failure_kind: 'transient', next_attempt_at: null, reason_code: null },
      expectedText: '보내지 못해 곧 다시 시도합니다',
      hasAction: false,
    },
    {
      name: '② blocked+connection — 연결 복구 대기, 링크 액션(문장 안에 내장)',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'blocked', failure_kind: 'connection', next_attempt_at: null, reason_code: null },
      expectedText: '채널 연결이 끊겨 멈췄습니다',
      hasAction: false, // 링크는 별도 버튼이 아니라 문장 안(t.rich)이라 아래 별도 검증
    },
    {
      name: '③ dead_letter(needs_check, fail-closed) — 사람 판단, 다시 상신 버튼',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'dead_letter', failure_kind: 'needs_check', next_attempt_at: null, reason_code: null },
      expectedText: '보내지 못했습니다',
      hasAction: true,
    },
    {
      name: '③ dead_letter(transient, MAX_RETRIES 소진) — needs_check와 같은 얼굴',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'dead_letter', failure_kind: 'transient', next_attempt_at: null, reason_code: null },
      expectedText: '보내지 못했습니다',
      hasAction: true,
    },
    {
      name: '④ voided+GATE_NOT_APPROVED_OR_RESEALED — 봉인 불일치, 다시 상신 버튼',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'voided', failure_kind: null, next_attempt_at: null, reason_code: 'GATE_NOT_APPROVED_OR_RESEALED' },
      expectedText: '승인한 답변과 지금 답변이 달라 보내지 않았습니다',
      hasAction: true,
    },
    {
      name: '⑤ voided+TARGET_COMMENT_DELETED — 대상 삭제, 액션 없음(되돌아올 수 없다)',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'voided', failure_kind: null, next_attempt_at: null, reason_code: 'TARGET_COMMENT_DELETED' },
      expectedText: '원 댓글이 지워져 보내지 못했습니다',
      hasAction: false,
    },
    {
      name: '⑥ voided+모르는 사유(예: CONTENT_CHANGED, 다른 경로가 공유 컬럼에 남길 수 있는 값) — 일반 문구, 액션 없음(아는 척 안 함)',
      reply: { ...FAILED_BASE, command_id: 'cmd-1', command_status: 'voided', failure_kind: null, next_attempt_at: null, reason_code: 'CONTENT_CHANGED' },
      expectedText: '보내지 못했습니다',
      hasAction: false,
    },
  ])('$name', async ({ reply, expectedText, hasAction }) => {
    const container = await mountWithReply(reply);
    const note = container.querySelector('[data-testid="comments-item-reply-failure-note"]');
    expect(note?.textContent).toContain(expectedText);
    expect(container.querySelector('[data-testid="comments-item-reply-retry-button"]') !== null
      || container.querySelector('[data-testid="comments-item-reply-resubmit-button"]') !== null).toBe(hasAction);
  });

  it('② blocked — 문장 안에 /organization/channels 링크가 실제로 있다', async () => {
    const container = await mountWithReply({
      ...FAILED_BASE, command_id: 'cmd-1', command_status: 'blocked', failure_kind: 'connection', next_attempt_at: null, reason_code: null,
    });
    const link = container.querySelector('[data-testid="comments-item-reply-failure-note"] a');
    expect(link?.getAttribute('href')).toBe('/organization/channels');
  });

  it('모르는 command_status(미래 값) — 실패 얼굴 자체를 안 그린다(칩은 여전히 "실패", 지어내지 않는다)', async () => {
    const container = await mountWithReply({
      ...FAILED_BASE, command_id: 'cmd-1', command_status: 'some_future_status', failure_kind: null, next_attempt_at: null, reason_code: null,
    });
    expect(container.querySelector('[data-testid="comments-item-reply-status"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="comments-item-reply-failure-note"]')).toBeNull();
  });

  it('null(성공 — reply.status="sent") — 실패 얼굴이 아예 없다', async () => {
    const container = await mountWithReply({
      id: 'r1', status: 'sent', external_reply_url: 'https://example.com/p/1', command_id: 'cmd-1',
      command_status: 'completed', failure_kind: null, next_attempt_at: null, reason_code: null,
    });
    expect(container.querySelector('[data-testid="comments-item-reply-failure-note"]')).toBeNull();
  });

  it('dead_letter인데 command_id가 없으면(레이스) 다시 상신 버튼이 비활성', async () => {
    const container = await mountWithReply({
      id: 'r1', status: 'failed', external_reply_url: null, command_id: null,
      command_status: 'dead_letter', failure_kind: 'needs_check', next_attempt_at: null, reason_code: null,
    });
    const btn = container.querySelector('[data-testid="comments-item-reply-retry-button"]') as HTMLButtonElement | null;
    expect(btn?.disabled).toBe(true);
  });

  // story #3544 REQUIRED 1(페드루 PO·유나 §22-15 확定, 2026-09-06) — dead_letter는
  // 이미 승인된 명령을 다시 큐에 올릴 뿐(재승인 없음)이라 "상신"(§17: 승인 요청)이
  // 아니다. voided(봉인 불일치)는 재승인이 실제로 필요해 "다시 상신"이 맞다 — 두
  // 메커니즘이 같은 낱말을 쓰면 안 된다(원 결함 재발 방지 pin).
  it('dead_letter CTA="다시 보내기"·voided(봉인 불일치) CTA="다시 상신" — 서로 다른 낱말(같으면 회귀)', async () => {
    const deadLetterContainer = await mountWithReply({
      ...FAILED_BASE, command_id: 'cmd-1', command_status: 'dead_letter', failure_kind: 'needs_check', next_attempt_at: null, reason_code: null,
    });
    const retryBtn = deadLetterContainer.querySelector('[data-testid="comments-item-reply-retry-button"]');
    expect(retryBtn?.textContent).toBe('다시 보내기');

    const voidedContainer = await mountWithReply({
      ...FAILED_BASE, command_id: 'cmd-1', command_status: 'voided', failure_kind: null, next_attempt_at: null, reason_code: 'GATE_NOT_APPROVED_OR_RESEALED',
    });
    const resubmitBtn = voidedContainer.querySelector('[data-testid="comments-item-reply-resubmit-button"]');
    expect(resubmitBtn?.textContent).toBe('다시 상신');
    expect(resubmitBtn?.textContent).not.toBe(retryBtn?.textContent);
  });
});
