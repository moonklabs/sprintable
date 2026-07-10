import { ArtifactViewer } from '@/components/canvas/artifact-viewer';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';

/**
 * E-CANVAS C1-S4 내부 프리뷰 — `docs/design-tokens`와 동일한 "라이브 dev QA용 인증된
 * 내부 라우트" 패턴. BE(`visual_artifact`) 계약 착지 前까지 mock 데이터로 뷰어 픽셀을
 * 검증하는 용도. 계약 착지 후 실 데이터 소비처(스토리 상세 등)가 생기면 이 페이지는
 * 회귀가드용 참조 렌더로 남겨둔다.
 */
export default function CanvasPreviewPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">E-CANVAS C1 — Artifact Viewer 프리뷰</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          mock 데이터(BE `visual_artifact` 계약 미착지) · 버전 클릭으로 lineage 전환 확인
        </p>
      </div>
      <ArtifactViewer
        artifact={MOCK_ARTIFACT}
        versions={MOCK_VERSIONS}
        memberMap={MOCK_MEMBERS}
        commentCount={2}
      />
    </div>
  );
}
