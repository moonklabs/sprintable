// story #3517(유나 §22-③, PO 確定 2026-09-05) — 댓글 본문은 «남의 글»이다. 링크·멘션을
// 실행 가능하게(클릭 가능한 <a>·하이라이트) 만들지 않는다 — 순수 텍스트로만 렌더한다
// (URL·@태그가 문자열에 있어도 절대 linkify하지 않는다, 콘텐츠 초안 편집기와 다른 축).
// 길면(COLLAPSE_THRESHOLD 초과) 기본 접힌 상태로 잘린 미리보기만 보이고, 눌러서 펼치면
// 전문이 보인다 — 네이티브 <details>(raw-details-toggle.tsx와 같은 관례, 접기/펼치기
// 둘 다 클릭 한 번으로 공짜)를 재사용한다.
const COLLAPSE_THRESHOLD = 200;

export function CommentBodyText({ text, moreLabel }: { text: string; moreLabel: string }) {
  if (text.length <= COLLAPSE_THRESHOLD) {
    return <p className="whitespace-pre-wrap text-sm text-foreground" data-testid="comment-body-text">{text}</p>;
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
