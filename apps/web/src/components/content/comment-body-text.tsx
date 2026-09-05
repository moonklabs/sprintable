// story #3517(유나 §22-③, PO 確定 2026-09-05) — 댓글 본문은 «남의 글»이다. 링크·멘션을
// 실행 가능하게(클릭 가능한 <a>·하이라이트) 만들지 않는다 — 순수 텍스트로만 렌더한다
// (URL·@태그가 문자열에 있어도 절대 linkify하지 않는다, 콘텐츠 초안 편집기와 다른 축).
// 길면(COLLAPSE_THRESHOLD 초과) 기본 접힌 상태로 잘린 미리보기만 보이고, 눌러서 펼치면
// 전문이 보인다 — 네이티브 <details>(raw-details-toggle.tsx와 같은 관례, 접기/펼치기
// 둘 다 클릭 한 번으로 공짜)를 재사용한다.
const COLLAPSE_THRESHOLD = 200;

export interface CommentBodyTextProps {
  text: string;
  moreLabel: string;
  /** story #3517(§22-9, PO 確定) — 지워진 댓글은 길이 무관 기본 접힘(짧아도 접는다).
   * uncontrolled <details defaultOpen={false}>로 항상 접힌 채 시작 — 펼치기는 여전히
   * 가능(text는 BE가 보존해서 준다, 숨기는 게 아니라 «남의 지워진 글»이라 기본을
   * 낮추는 것뿐). */
  forceCollapsed?: boolean;
  /** forceCollapsed=true일 때만 쓰는 summary 라벨. 유나 Design 재리뷰(2026-09-05) —
   * <summary>는 <details> 닫힘 상태에서도 항상 보이므로, 길이 기반 미리보기(preview)를
   * 그대로 쓰면 200자 이하 지워진 글은 "접혀도" 본문이 전문 그대로 보였다(닫힌 채
   * 다 보이는 결함 — 실측). 지워진 글은 이 라벨만 쓰고 본문은 «한 글자도» summary에
   * 안 넣는다 — 펼쳐야만 보인다. */
  deletedSummaryLabel?: string;
}

export function CommentBodyText({ text, moreLabel, forceCollapsed, deletedSummaryLabel }: CommentBodyTextProps) {
  if (!forceCollapsed && text.length <= COLLAPSE_THRESHOLD) {
    return <p className="whitespace-pre-wrap text-sm text-foreground" data-testid="comment-body-text">{text}</p>;
  }
  if (forceCollapsed) {
    return (
      <details className="text-sm text-foreground" data-testid="comment-body-text">
        <summary className="cursor-pointer">
          <span className="text-muted-foreground underline">{deletedSummaryLabel}</span>
        </summary>
        <p className="mt-1 whitespace-pre-wrap">{text}</p>
      </details>
    );
  }
  const preview = text.slice(0, COLLAPSE_THRESHOLD).trimEnd();
  return (
    <details className="text-sm text-foreground" data-testid="comment-body-text">
      <summary className="cursor-pointer whitespace-pre-wrap">
        {preview}
        {'… '}
        <span className="text-muted-foreground underline">{moreLabel}</span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </details>
  );
}
