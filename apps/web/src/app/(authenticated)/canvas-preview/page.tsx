import { CanvasPreviewClient } from './canvas-preview-client';

/**
 * E-CANVAS C1/C2/C3 내부 프리뷰 — `docs/design-tokens`와 동일한 "라이브 dev QA용 인증된
 * 내부 라우트" 패턴. BE(`visual_artifact`/`comment`) 계약 착지 前까지 mock 데이터로 뷰어
 * 픽셀을 검증하는 용도. 계약 착지 후 실 데이터 소비처(스토리 상세 등)가 생기면 이 페이지는
 * 회귀가드용 참조 렌더로 남겨둔다.
 *
 * ⚠️ `/docs/canvas-preview`(docs 하위)에서 여기로 이동(선생님 지적, 2026-07-10) — docs
 * 라우트 레이아웃(`docs-client-layout.tsx`)의 `overflow-hidden` 고정 높이 셸을 상속받아
 * 세로 스크롤이 막혀 하단 콘텐츠(C3)를 볼 수 없었음. 최상위 `(authenticated)` 라우트는
 * `DashboardShell`의 `overflow-y-auto` 스크롤 컨테이너를 상속해 정상 스크롤된다 — 근본
 * 원인이 페이지 자체가 아니라 상위 레이아웃 상속이었으므로, "이 라우트가 있어야 할 자리가
 * 아니었다"는 판단으로 이동이 곧 수정이다(자체 overflow-y-auto 래퍼로 땜질하지 않음).
 */
export default function CanvasPreviewPage() {
  return <CanvasPreviewClient />;
}
