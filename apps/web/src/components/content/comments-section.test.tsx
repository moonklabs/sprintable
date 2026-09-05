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
    ...overrides,
  };
}

function loadedFace(comments: CommentItem[], overrides: Partial<Extract<CommentsFace, { kind: 'loaded' }>> = {}): CommentsFace {
  return {
    kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z',
    comments, activeCount: comments.filter((c) => !c.deletedAt).length, deletedCount: comments.filter((c) => c.deletedAt).length,
    ...overrides,
  };
}

function emptyFace(comments: CommentItem[], overrides: Partial<Extract<CommentsFace, { kind: 'empty' }>> = {}): CommentsFace {
  return {
    kind: 'empty', capturedAt: '2026-09-05T10:00:00Z',
    comments, activeCount: comments.filter((c) => !c.deletedAt).length, deletedCount: comments.filter((c) => c.deletedAt).length,
    ...overrides,
  };
}

describe('CommentsSection — 세 얼굴(story #3517 §22-②)', () => {
  it('uncollected(null) — "아직 수집 전"만 뜨고 목록·수집시각은 안 뜬다', async () => {
    const face: CommentsFace = { kind: 'uncollected' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-face-uncollected"]')?.textContent).toBe('아직 수집 전입니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-item"]')).toBeNull();
  });

  it('error(fetch 실패) — "불러오지 못했습니다"만 뜬다(0건과 다른 문구)', async () => {
    const face: CommentsFace = { kind: 'error' };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-face-error"]')?.textContent).toBe('댓글을 불러오지 못했습니다.');
  });

  it('empty([]) — "댓글이 없습니다"+수집시각+제목에 0건(uncollected/error와 다른 문구·표시)', async () => {
    const face: CommentsFace = { kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', comments: [], activeCount: 0, deletedCount: 0 };
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-face-empty"]')?.textContent).toBe('댓글이 없습니다.');
    expect(container.querySelector('[data-testid="comments-captured-at"]')?.textContent).toContain('09-05');
    expect(container.querySelector('h3')?.textContent).toBe('댓글 0');
  });

  it('loaded(n건) — 목록·수집시각·제목의 카운트 모두 뜬다', async () => {
    const face = loadedFace([baseComment({})]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
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
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('h3')?.textContent).toBe('댓글 42');
  });

  // story #3517(유나 §22-10②, PO 確定 2026-09-05) — 작성자 없으면 이 화면 전용
  // 문구("작성자 정보 없음")를 쓴다(공유 「모름」이 아니다 — 구체적으로 뭘 못
  // 받았는지 말한다).
  it('작성자 표시명이 없으면(null) "작성자 정보 없음"(공유 「모름」이 아니다)', async () => {
    const face = loadedFace([baseComment({ authorDisplayName: null })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-item-author"]')?.textContent).toBe('작성자 정보 없음');
  });

  it('externalCreatedAt이 있으면 그 값을 그대로 보인다(작성 시각)', async () => {
    const face = loadedFace([baseComment({ externalCreatedAt: '2026-09-05T09:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-item-authored-at"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="comments-item-captured-at"]')).toBeNull();
  });

  // story #3517(유나 §22-10②) — external_created_at이 없으면 capturedAt으로
  // 폴백하되 라벨을 "작성"이 아니라 "수집"으로 바꾼다(captured_at을 작성 시각으로
  // 적으면 거짓말 — 우리가 발견한 시각일 뿐이다).
  it('externalCreatedAt이 null이면 capturedAt+"수집" 라벨로 폴백한다(지어내지 않되 자리를 비우지 않는다)', async () => {
    const face = loadedFace([baseComment({ externalCreatedAt: null, capturedAt: '2026-09-05T10:30:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
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
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelectorAll('[data-testid="comments-item"]').length).toBe(1);
    expect(container.querySelector('[data-testid="comments-item-deleted-note"]')?.textContent).toBe('원본이 지워졌습니다.');
  });

  // story #3517(PO 지정 순서, 2026-09-05) — §22-9 문장 순서: 사유가 위, 본문이 아래.
  it('사유("원본이 지워졌습니다")가 본문(comment-body-text)보다 DOM에서 먼저 온다', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    const item = container.querySelector('[data-testid="comments-item"]')!;
    const note = item.querySelector('[data-testid="comments-item-deleted-note"]')!;
    const body = item.querySelector('[data-testid="comment-body-text"]')!;
    expect(note.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('deletedAt이 null이면 지워짐 안내가 안 뜬다(회귀 0)', async () => {
    const face = loadedFace([baseComment({ deletedAt: null })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
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
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
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
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    const body = container.querySelector('[data-testid="comment-body-text"]');
    expect(body?.tagName).toBe('DETAILS');
    const summary = body?.querySelector('summary');
    expect(summary?.textContent).not.toContain('짧은 글');
    // 펼치면(<p>) 여전히 전문이 있다 — text는 보존돼 온다, 숨기는 게 아니다.
    const expandedBody = body?.querySelector('p');
    expect(expandedBody?.textContent).toContain('짧은 글');
  });

  it('지워진 댓글엔 행 액션(작업으로 전환·답변)이 아예 안 그려진다(비활성이 아니라 부재)', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-item-convert-to-task"]')).toBeNull();
    expect(container.querySelector('[data-testid="comments-item-reply"]')).toBeNull();
    expect(container.querySelector('[data-comment-reply-status-chip]')).toBeNull(); // 답변 상태 칩도(액션 축 전체가 무의미).
  });

  it('deletedCount>0이면 헤더에 "지워진 댓글 {n}건" 안내가 뜬다(서버 전체 수)', async () => {
    const face = loadedFace([baseComment({ deletedAt: '2026-09-05T11:00:00Z' })], { deletedCount: 3 });
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-deleted-count"]')?.textContent).toBe('지워진 댓글 3건');
  });

  it('deletedCount=0이면 그 안내 줄 자체가 안 뜬다', async () => {
    const face = loadedFace([baseComment({})], { deletedCount: 0 });
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-deleted-count"]')).toBeNull();
  });
});

// story #3517(BE #3867 조각②, PO 確定 2026-09-05) — 행 액션 재도입. 답변 상태 칩은
// 여전히 렌더 안 함(그라운딩 확認 — 댓글 목록 GET에 reply 존재 여부가 없어 BE 벌크
// 조회 별건 대기 중, 신호 없는 자리를 지어내지 않는다).
describe('CommentsSection — 행 액션(story #3517 조각②)', () => {
  it('지워지지 않은 댓글엔 작업전환·답변 버튼이 뜬다(답변 상태 칩은 아직 안 뜬다)', async () => {
    const face = loadedFace([baseComment({})]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={() => {}} />)); });
    expect(container.querySelector('[data-testid="comments-item-convert-to-task"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="comments-item-reply"]')).not.toBeNull();
    expect(container.querySelector('[data-comment-reply-status-chip]')).toBeNull();
  });

  it('「작업으로 전환」 클릭 — 그 댓글 객체 그대로 콜백에 전달된다', async () => {
    const comment = baseComment({});
    const onConvertToTask = vi.fn();
    const face = loadedFace([comment]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={onConvertToTask} onReply={() => {}} />)); });
    const btn = container.querySelector('[data-testid="comments-item-convert-to-task"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onConvertToTask).toHaveBeenCalledWith(comment);
  });

  it('「답변」 클릭 — 그 댓글 객체 그대로 콜백에 전달된다', async () => {
    const comment = baseComment({});
    const onReply = vi.fn();
    const face = loadedFace([comment]);
    const { container, root } = mount();
    await act(async () => { root.render(wrap(<CommentsSection face={face} displayTimezone={TZ} onRefresh={async () => ({ ok: true })} onConvertToTask={() => {}} onReply={onReply} />)); });
    const btn = container.querySelector('[data-testid="comments-item-reply"]') as HTMLButtonElement;
    await act(async () => { btn.click(); });
    expect(onReply).toHaveBeenCalledWith(comment);
  });
});

// story #3517(BE #3865 조각①, PO 確定 2026-09-05) — 원 응답(snake_case)→CommentsFace
// 매핑. 세 얼굴 판정이 이 함수 하나로만 결정되게(페이지가 직접 if/else로 판정하지
// 않는다) 단위테스트로 고정.
describe('deriveCommentsFace(story #3517, BE #3865 조각① 응답 매핑)', () => {
  function rawResponse(overrides: Partial<RawCommentsResponse>): RawCommentsResponse {
    return { last_collected_at: '2026-09-05T10:00:00Z', comments: [], active_count: 0, deleted_count: 0, ...overrides };
  }

  it('last_collected_at=null → uncollected', () => {
    expect(deriveCommentsFace(rawResponse({ last_collected_at: null }))).toEqual({ kind: 'uncollected' });
  });

  it('active_count=0·deleted_count=0 → empty', () => {
    const face = deriveCommentsFace(rawResponse({}));
    expect(face).toEqual({ kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', comments: [], activeCount: 0, deletedCount: 0 });
  });

  it('active_count>0 → loaded, 필드명이 camelCase로 정확히 옮겨진다', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 1,
      comments: [{
        id: 'c1', external_comment_id: 'ext-1', author_display_name: '홍길동', text: '본문',
        external_created_at: '2026-09-05T09:00:00Z', captured_at: '2026-09-05T10:00:00Z', deleted_at: null,
      }],
    }));
    expect(face).toEqual({
      kind: 'loaded', capturedAt: '2026-09-05T10:00:00Z', activeCount: 1, deletedCount: 0,
      comments: [{
        id: 'c1', authorDisplayName: '홍길동', bodyText: '본문',
        externalCreatedAt: '2026-09-05T09:00:00Z', capturedAt: '2026-09-05T10:00:00Z', deletedAt: null, replyStatus: 'none',
      }],
    });
  });

  // 조각②(답변/작업전환) 미착지 — replyStatusFor를 안 주면 지어내지 않고 전부 'none'.
  it('replyStatusFor 없으면 전부 replyStatus="none"(조각② 대기, 지어내지 않는다)', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 1,
      comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: null, text: 'x', external_created_at: null, captured_at: 't', deleted_at: null }],
    }));
    expect(face.kind).toBe('loaded');
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyStatus).toBe('none');
  });

  // story #3517(유나 §22-10①·⑨, PO 確定 2026-09-05 정정) — "댓글 없음" 판정은
  // active_count 하나만 본다. deleted_count>0(전부 지워짐)이어도 active_count=0이면
  // "댓글 없음" 얼굴이다 — deletedCount는 그 empty 얼굴 자체가 들고 있어(SectionHeader
  // 의 "지워진 댓글 {n}건" 안내) 지워진 사실 자체가 사라지진 않는다.
  it('active_count=0인데 deleted_count>0이면(전부 지워짐)도 empty이되, 지워진 행은 comments에 그대로 실린다(§22-9 "원래 자리")', () => {
    const face = deriveCommentsFace(rawResponse({
      active_count: 0, deleted_count: 1,
      comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: null, text: 'x', external_created_at: null, captured_at: 't', deleted_at: '2026-09-05T11:00:00Z' }],
    }));
    expect(face).toEqual({
      kind: 'empty', capturedAt: '2026-09-05T10:00:00Z', activeCount: 0, deletedCount: 1,
      comments: [{
        id: 'c1', authorDisplayName: null, bodyText: 'x',
        externalCreatedAt: null, capturedAt: 't', deletedAt: '2026-09-05T11:00:00Z', replyStatus: 'none',
      }],
    });
  });

  it('replyStatusFor를 주면 그 함수의 판정을 그대로 쓴다', () => {
    const face = deriveCommentsFace(
      rawResponse({
        active_count: 1,
        comments: [{ id: 'c1', external_comment_id: 'ext-1', author_display_name: null, text: 'x', external_created_at: null, captured_at: 't', deleted_at: null }],
      }),
      () => 'approved',
    );
    expect((face as Extract<CommentsFace, { kind: 'loaded' }>).comments[0]!.replyStatus).toBe('approved');
  });
});
