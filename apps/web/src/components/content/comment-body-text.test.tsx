// @vitest-environment jsdom
//
// story #3517(유나 §22-③) — 댓글 본문 렌더 회귀가드: 링크·멘션 비실행(절대 <a> 없음),
// 짧으면 그대로·길면 접힌 미리보기+펼치면 전문.
import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { CommentBodyText } from './comment-body-text';

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

describe('CommentBodyText', () => {
  it('짧은 본문 — 그대로 <p>로 렌더', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CommentBodyText text="좋은 글이네요!" moreLabel="더보기" />); });
    const el = container.querySelector('[data-testid="comment-body-text"]');
    expect(el?.tagName).toBe('P');
    expect(el?.textContent).toBe('좋은 글이네요!');
  });

  it('URL이 포함돼도 <a> 태그를 만들지 않는다(링크 비실행)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CommentBodyText text="이거 보세요 https://example.com/x 대박" moreLabel="더보기" />); });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('https://example.com/x');
  });

  it('@멘션이 포함돼도 하이라이트/링크가 안 걸린다(멘션 비실행)', async () => {
    const { container, root } = mount();
    await act(async () => { root.render(<CommentBodyText text="@someone 동의합니다" moreLabel="더보기" />); });
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[data-mention]')).toBeNull();
    expect(container.textContent).toContain('@someone');
  });

  it('긴 본문(200자 초과) — 기본 접힘(<details> 미열림)·펼치면 전문이 있다', async () => {
    const long = 'x'.repeat(250);
    const { container, root } = mount();
    await act(async () => { root.render(<CommentBodyText text={long} moreLabel="더보기" />); });
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('더보기');
    // 전문(250자)은 이미 DOM에 있다(details 안, 접혀 있을 뿐 — 검색엔진/스크린리더 접근 가능).
    expect(details.textContent).toContain(long);
  });

  it('짧은 본문(정확히 200자)은 접히지 않는다(경계값)', async () => {
    const exact = 'y'.repeat(200);
    const { container, root } = mount();
    await act(async () => { root.render(<CommentBodyText text={exact} moreLabel="더보기" />); });
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('[data-testid="comment-body-text"]')?.tagName).toBe('P');
  });

  // story #3517(유나 Design 재리뷰, 2026-09-05) — forceCollapsed는 길이 무관 접힘인데,
  // <summary>는 <details> 닫힘 상태에서도 항상 보인다. 길이 기반 preview를 그대로
  // 쓰면(200자 이하 → preview===전문) "접혀도" 본문이 그대로 다 보이는 결함이 있었다.
  describe('forceCollapsed(§22-9 지워진 댓글)', () => {
    it('짧은 본문이어도 <summary>엔 라벨만, 본문 문자열이 한 글자도 없다', async () => {
      const { container, root } = mount();
      await act(async () => {
        root.render(<CommentBodyText text="짧은 글" moreLabel="더보기" forceCollapsed deletedSummaryLabel="본문 펼치기" />);
      });
      const details = container.querySelector('details') as HTMLDetailsElement;
      expect(details).not.toBeNull();
      expect(details.open).toBe(false);
      const summary = details.querySelector('summary');
      expect(summary?.textContent).toBe('본문 펼치기');
      expect(summary?.textContent).not.toContain('짧은 글');
    });

    it('짧은 본문이어도 펼치면(<p>) 전문이 그대로 있다(text는 보존돼 온다)', async () => {
      const { container, root } = mount();
      await act(async () => {
        root.render(<CommentBodyText text="짧은 글" moreLabel="더보기" forceCollapsed deletedSummaryLabel="본문 펼치기" />);
      });
      const p = container.querySelector('details p');
      expect(p?.textContent).toBe('짧은 글');
    });

    it('긴 본문이어도(200자 초과) 마찬가지로 summary엔 라벨만 — 길이 기반 preview로 새지 않는다', async () => {
      const long = 'x'.repeat(250);
      const { container, root } = mount();
      await act(async () => {
        root.render(<CommentBodyText text={long} moreLabel="더보기" forceCollapsed deletedSummaryLabel="본문 펼치기" />);
      });
      const summary = container.querySelector('details summary');
      expect(summary?.textContent).toBe('본문 펼치기');
      expect(summary?.textContent).not.toContain('x');
    });
  });
});
