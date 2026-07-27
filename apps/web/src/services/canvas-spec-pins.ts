/**
 * E-CANVAS 편집 캔버스 "핀 추가" (story 7fe16274) — 스펙 핀 FE 어댑터.
 * BE(`visual_artifacts.py` pins 엔드포인트, #2140)를 직접 읽고 확인: 항상 artifact의
 * latest version 대상(과거 버전 핀은 불변 스냅샷). doc `artifact-pin-authoring-spec`
 * v1 스코프 = ⓐ 좌표 배치만(anchor_type='coord') — node 배치(ⓑ)는 후속.
 *
 * ⛔감시금지(spec §4): BE `SpecPinResponse`엔 애초에 created_by/created_at 컬럼 자체가
 * 없다 — FE도 꾸며내지 않는다(no-fiction).
 */

export type SpecPinAnchorType = 'coord' | 'node';

export interface SpecPin {
  id: string;
  artifactId: string;
  versionId: string;
  anchorType: SpecPinAnchorType;
  /** anchor_type='coord'일 때만 — canvas_bounds 좌표계(px, % 아님). */
  anchorX: number | null;
  anchorY: number | null;
  nodeId: string | null;
  description: string;
}

/** BE `SpecPinResponse`(schemas/visual_artifact.py) 미러 — flat 응답. */
export interface BeSpecPin {
  id: string;
  artifact_id: string;
  version_id: string;
  anchor_type: string;
  anchor_x: number | null;
  anchor_y: number | null;
  node_id: string | null;
  description: string;
}

export function adaptSpecPin(p: BeSpecPin): SpecPin {
  return {
    id: p.id,
    artifactId: p.artifact_id,
    versionId: p.version_id,
    anchorType: p.anchor_type === 'node' ? 'node' : 'coord',
    anchorX: p.anchor_x,
    anchorY: p.anchor_y,
    nodeId: p.node_id,
    description: p.description,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T };
    return json.data ?? null;
  } catch {
    return null;
  }
}

export async function listSpecPins(artifactId: string): Promise<SpecPin[]> {
  const rows = await fetchJson<BeSpecPin[]>(`/api/visual-artifacts/${artifactId}/pins`);
  return (rows ?? []).map(adaptSpecPin);
}

/** v1 스코프 = 좌표 배치만 — anchorX/anchorY 필수(node 배치는 후속, 이 함수는 다루지 않음). */
export async function createSpecPin(
  artifactId: string, anchorX: number, anchorY: number, description: string,
): Promise<SpecPin | null> {
  const created = await fetchJson<BeSpecPin>(`/api/visual-artifacts/${artifactId}/pins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ anchor_type: 'coord', anchor_x: anchorX, anchor_y: anchorY, description }),
  });
  return created ? adaptSpecPin(created) : null;
}

export async function updateSpecPin(artifactId: string, pinId: string, description: string): Promise<SpecPin | null> {
  const updated = await fetchJson<BeSpecPin>(`/api/visual-artifacts/${artifactId}/pins/${pinId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  return updated ? adaptSpecPin(updated) : null;
}

export async function deleteSpecPin(artifactId: string, pinId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/visual-artifacts/${artifactId}/pins/${pinId}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}
