import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentThreadCard } from './comment-thread-card';
import { MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('CommentThreadCard', () => {
  it('shows the resolved-by note and dims the card once resolved', () => {
    const resolved = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={resolved} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('opacity-70');
    expect(markup).toContain('해결됨');
    expect(markup).toContain('미르코 페트로비치가 해결함');
  });

  it('hides the reply/resolve controls once a thread is resolved (no false affordance)', () => {
    const resolved = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={resolved} memberMap={MOCK_MEMBERS} />));
    expect(markup).not.toContain('답글…');
  });

  it('shows reply/resolve controls for an open thread', () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={open} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('답글…');
    expect(markup).toContain('해결');
  });

  it('shows the result-link note when the thread has a resultVersion (C3-S7 closed-loop, "주어=결과")', () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const withResult = { ...open, resultVersion: 5 };
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={withResult} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('v5 생성');
  });

  it('omits the result-link note when resultVersion is null', () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={{ ...open, resultVersion: null }} memberMap={MOCK_MEMBERS} />));
    expect(markup).not.toContain('생성 — 이 코멘트가 입력');
  });

  it('never uses surveillance vocabulary anywhere in the rendered markup (리트머스 회귀가드)', () => {
    const markup = MOCK_THREADS.map((t) => renderToStaticMarkup(wrap(<CommentThreadCard thread={t} memberMap={MOCK_MEMBERS} />))).join('');
    for (const forbidden of ['방치', '무시', '늦음', '감점', '응답률', '미처리']) {
      expect(markup).not.toContain(forbidden);
    }
  });

  // story #3009(로드맵 P2·PR-F, L1) — 인라인 카드는 --elev-card.
  it('카드 셸이 shadow-[var(--elev-card)]를 쓰고 shadow-sm은 안 쓴다', () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={open} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('shadow-[var(--elev-card)]');
    expect(markup).not.toMatch(/shadow-sm["\s]/);
  });
});

// [SID:4311 PR 3] 댓글 줄 작성자 — 같은 이름 서로 다른 작성자 둘이면 «· ID 앞 8자»(작성자 id마다 한 번) · 해결한 사람 문장도 같은 표.
describe('CommentThreadCard — 작성자 동명이인([SID:4311 PR 3])', () => {
  const members = {
    'e75ca548-1': { id: 'e75ca548-1', name: '송윤재' },
    '2fd14616-2': { id: '2fd14616-2', name: '송윤재' },
    'm-anna': { id: 'm-anna', name: '안나' },
  };
  const base = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
  const thread = {
    ...base,
    comments: [
      { id: 'x1', author_id: 'e75ca548-1', body: '첫 댓글', created_at: '2026-09-25T00:00:00Z' },
      { id: 'x2', author_id: '2fd14616-2', body: '둘째 댓글', created_at: '2026-09-25T00:01:00Z' },
      { id: 'x3', author_id: 'm-anna', body: '셋째 댓글', created_at: '2026-09-25T00:02:00Z' },
      { id: 'x4', author_id: 'e75ca548-1', body: '넷째 댓글', created_at: '2026-09-25T00:03:00Z' },
    ],
    resolved_by: '2fd14616-2',
  };
  it('«송윤재» 둘 = 줄마다 id 앞 8자 · 같은 사람 두 줄 = 같은 꼬리 · 안나 = 꼬리 없음 · 해결 문장도 같은 표(조사는 최종 라벨 끝소리)', () => {
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={thread} memberMap={members} />));
    const authors = [...markup.matchAll(/<strong[^>]*>([^<]*)<\/strong>/g)].map((m) => m[1]);
    expect(authors).toEqual(['송윤재 · e75ca548', '송윤재 · 2fd14616', '안나', '송윤재 · e75ca548']);
    expect(markup).toContain('송윤재 · 2fd14616이 해결함');
  });
});

