'use client';

import { useEffect, useState } from 'react';
import { ArtifactViewer } from './artifact-viewer';
import { adaptArtifactDetail, type ArtifactVersion, type MemberRef, type VisualArtifact, type VisualArtifactDetailResponse } from '@/services/canvas';

interface ArtifactSectionProps {
  storyId: string;
  memberMap?: Record<string, MemberRef>;
  className?: string;
}

/**
 * E-CANVAS AC2(스토리 상세 첨부) — 실 데이터 attachment point. BE(`GET /api/visual-artifacts`,
 * C1-S3)가 아직 라우터 자체를 안 갖고 있어(§6 체크리스트 미완) 지금은 모든 스토리에서 404 →
 * **완전 무표시**로 귀결된다(mock 폴백 0 — 선생님 slop 지적 반영, 없는 걸 있는 척 안 함).
 * BE 착지 즉시 이 컴포넌트가 살아서 실 artifact를 렌더한다.
 */
export function ArtifactSection({ storyId, memberMap = {}, className }: ArtifactSectionProps) {
  const [items, setItems] = useState<{ artifact: VisualArtifact; versions: ArtifactVersion[] }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listRes = await fetch(`/api/visual-artifacts?story_id=${storyId}`);
        if (!listRes.ok) return; // 404(BE 미착지) = "첨부 없음"과 동일 취급, 조용히 무표시
        const listJson = (await listRes.json()) as { data?: VisualArtifact[] };
        const artifacts = listJson.data ?? [];
        if (artifacts.length === 0) return;

        const details = await Promise.all(artifacts.map(async (a) => {
          const detailRes = await fetch(`/api/visual-artifacts/${a.id}`);
          if (!detailRes.ok) return null;
          const detailJson = (await detailRes.json()) as { data?: VisualArtifactDetailResponse };
          if (!detailJson.data) return null;
          return adaptArtifactDetail(detailJson.data);
        }));

        if (!cancelled) setItems(details.filter((d) => d !== null));
      } catch {
        // 네트워크 예외도 "첨부 없음"과 동일 취급 — 스토리 상세 화면 자체를 깨뜨리지 않는다.
      }
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  if (items.length === 0) return null;

  return (
    <div className={className}>
      {items.map(({ artifact, versions }) => (
        <ArtifactViewer key={artifact.id} artifact={artifact} versions={versions} memberMap={memberMap} />
      ))}
    </div>
  );
}
