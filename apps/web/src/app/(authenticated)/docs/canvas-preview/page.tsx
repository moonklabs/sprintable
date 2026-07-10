import { CanvasPreviewClient } from './canvas-preview-client';

/**
 * E-CANVAS C1/C2 내부 프리뷰 — `docs/design-tokens`와 동일한 "라이브 dev QA용 인증된
 * 내부 라우트" 패턴. BE(`visual_artifact`/`comment`) 계약 착지 前까지 mock 데이터로 뷰어
 * 픽셀을 검증하는 용도. 계약 착지 후 실 데이터 소비처(스토리 상세 등)가 생기면 이 페이지는
 * 회귀가드용 참조 렌더로 남겨둔다.
 */
export default function CanvasPreviewPage() {
  return <CanvasPreviewClient />;
}
