/**
 * E-CANVAS C1 — 시각 산출물(visual artifact) FE 타입.
 *
 * `VisualArtifact`/`ArtifactVersion`(아래)은 **컴포넌트가 소비하는 FE-내부 shape**이고, 실
 * BE 응답(flat, `format` 없음)과는 다르다 — 그 변환은 `adaptArtifactDetail`이 전담한다(§ 하단).
 * BE 실 스키마는 2026-07-10 `feat/e-canvas-c1-s3-visual-artifact`(PR 대기 중) 소스를 직접 읽고
 * 확認 — 더 이상 blueprint 추상 모델 추정이 아니다. dev 배포는 아직(브랜치 미머지) — 어댑터는
 * 준비됐고 머지되는 순간 이 파이프가 실 렌더로 이어진다.
 */

import type { ArtifactNode, NodeOperation } from './canvas-nodes';
import { resolveNodeTree } from './canvas-nodes';

export type ArtifactFormat = 'html' | 'tree' | 'image';

/** blueprint §2: `artifact_version`(내용 blob/tree·변경자·요약). */
export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  /** format='html'→HTML 문자열, format='image'→이미지 URL, format='tree'→JSON 직렬화 노드 트리(§2 tree 노드). */
  content: string;
  created_by: string;
  /** 변경 이유(의미 단위) — raw 편집 나열 아님(핸드오프 §6 감시 게이트). */
  summary: string | null;
  created_at: string;
  /** story 1948d19d §4(BE #2135) — 그 버전의 불변 스냅샷 아트보드 크기. nullable(레거시/미선언) —
   * ArtifactStage가 null이면 포맷별 기본 아트보드로 폴백(가짜 추정 0, 측정 아니라 선언). */
  canvasBounds?: { w: number; h: number } | null;
}

/**
 * BE 계약 SSOT(`e-canvas-c1-be-contract` §3 `visual_artifacts`) 미러.
 * `source`: 'created'(에이전트/휴먼 생성)|'imported'(Figma/HTML붙여넣기/이미지) — untrusted
 * 임포트 콘텐츠의 iframe sandbox 차등 근거(§3 doc). 지금 FE는 두 source 모두 완전잠금
 * `sandbox=""`으로 통일 처리 중 — source별 완화는 C1 실연동 때 minor 보완(유나 리뷰 합의).
 */
export interface VisualArtifact {
  id: string;
  title: string;
  format: ArtifactFormat;
  current_version: number;
  /** 승인된 정본 버전 번호. null=아직 정본 없음(초안 중립 — 배지 무표시). */
  anchor_version: number | null;
  created_by: string;
  source: 'created' | 'imported';
  /** BE 계약 §3 — 연결 대상 3종 中 최대 1개(nullable). AC2(스토리 첨부)의 조회 키. */
  story_id?: string | null;
  epic_id?: string | null;
  doc_id?: string | null;
}

export interface MemberRef {
  id: string;
  name: string;
}

// ─── 잠정 mock 데이터 (핸드오프 doc `e-canvas-trust-surface-mockup-render` 예시와 동일 콘텐츠) ──

export const MOCK_MEMBERS: Record<string, MemberRef> = {
  m1: { id: 'm1', name: '미르코 페트로비치' },
  m2: { id: 'm2', name: '유나 홀름' },
  m3: { id: 'm3', name: '디디 은와추쿠' },
  m4: { id: 'm4', name: '파울로 오르테가' },
  m5: { id: 'm5', name: '담롱 온찬' },
};

export const MOCK_ARTIFACT: VisualArtifact = {
  id: 'mock-artifact-1',
  title: '결제 복구 플로우 목업',
  format: 'html',
  current_version: 4,
  anchor_version: 3,
  created_by: 'm2',
  source: 'created',
};

/** C3 편집 데모용 — tree 포맷·정본 없음(초안이라 자유 편집 가능). */
export const MOCK_EDITABLE_ARTIFACT: VisualArtifact = {
  id: 'mock-artifact-2',
  title: '결제 복구 플로우 (편집용 초안)',
  format: 'tree',
  current_version: 1,
  anchor_version: null,
  created_by: 'm1',
  source: 'created',
};

const MOCK_HTML_V4 = `<!doctype html><html><head><style>
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:20px;background:#fff;color:#1a1a1a}
  .card{max-width:320px;margin:0 auto;border:1px solid #e5e5e5;border-radius:12px;padding:20px}
  h4{margin:0 0 4px;font-size:15px}
  .sub{font-size:11.5px;color:#767676;margin-bottom:16px}
  .field{height:34px;border:1px solid #e5e5e5;border-radius:8px;background:#fafafa;margin-bottom:9px}
  .btn{height:38px;border-radius:9px;background:#3157ff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;margin-top:4px}
  .toast{margin-top:12px;font-size:11px;color:#767676;background:#fafafa;border:1px solid #e5e5e5;border-radius:7px;padding:7px 9px}
</style></head><body>
  <div class="card">
    <h4>결제 복구</h4>
    <div class="sub">실패한 결제를 다시 시도합니다</div>
    <div class="field"></div>
    <div class="field"></div>
    <div class="btn">다시 결제하기</div>
    <div class="toast">카드가 거절되었습니다</div>
  </div>
</body></html>`;

// ─── 실 API 어댑터 (AC2 attachment point) ───────────────────────────────────
// BE(`feat/e-canvas-c1-s3-visual-artifact` — 실측 완료, PR 대기 중·2026-07-10) 실 라우터/스키마
// (`backend/app/routers/visual_artifacts.py`·`schemas/visual_artifact.py`)를 직접 읽고 정정 —
// 더 이상 추정 아님. 실 계약의 중요한 이탈점: **`format` 컬럼이 BE에 없다** — blueprint 추상
// 모델엔 있었지만 실 스키마는 노드 구성으로 format을 암묵 표현한다(`html_blob` 캐치올 노드가
// 있으면 그 props로 html/image 판별, 없으면 구조화 tree). `latest_version_number`도 실 필드명
// (내 FE 컴포넌트의 `current_version`과 이름이 다름 — 여기 어댑터가 흡수, 컴포넌트는 안 건드림).

/** 살아있는 노드 구성으로 format을 유도 — BE가 저장하지 않는 파생값. */
export function deriveFormat(nodes: ArtifactNode[]): ArtifactFormat {
  const blob = nodes.find((n) => n.type === 'html_blob');
  if (!blob) return 'tree';
  return typeof blob.props['src'] === 'string' ? 'image' : 'html';
}

/** BE `ArtifactNodeOut`(schemas/visual_artifact.py) 미러 — canvas-nodes.ts의 `ArtifactNode`와 동형. */
export type BeArtifactNode = ArtifactNode;

/**
 * BE `VisualArtifactDetail`(schemas/visual_artifact.py) 미러 — flat 응답(중첩 아님).
 * `canvas_bounds`: story 1948d19d §4(BE #2135) — 이 버전(`version_number`)의 불변 스냅샷
 * 아트보드 크기. nullable(레거시/미선언 허용) — #2135 머지 전엔 항상 undefined로 와도 무해
 * (FE는 폴백 우선 설계라 옵셔널로만 소비).
 */
export interface BeVisualArtifactDetail {
  id: string;
  title: string;
  story_id: string | null;
  epic_id: string | null;
  doc_id: string | null;
  source: 'created' | 'imported';
  latest_version_number: number;
  anchor_version: number | null;
  created_by: string | null;
  created_at: string;
  version_number: number;
  version_summary: string | null;
  nodes: BeArtifactNode[];
  canvas_bounds?: { w: number; h: number } | null;
}

/** BE `VisualArtifactSummary` 미러 — `GET /api/v2/visual-artifacts?story_id=` 목록 항목(nodes 없음).
 * `canvas_bounds`: BE #2135 — latest 버전의 denorm 캐시(§4-1). */
export interface BeVisualArtifactSummary {
  id: string;
  title: string;
  story_id: string | null;
  epic_id: string | null;
  doc_id: string | null;
  source: 'created' | 'imported';
  latest_version_number: number;
  anchor_version: number | null;
  created_by: string | null;
  created_at: string;
  canvas_bounds?: { w: number; h: number } | null;
}

/**
 * BE `ArtifactVersionSummary` 미러 — `GET /{id}/versions`(C1-S3) 목록 항목(nodes 없음).
 * `source_comment_id`는 C3-S7(story 940266db) closed-loop 필드: 이 버전이 어느 코멘트에
 * 응답해 생성됐는지. 신규 fetch 없이 이 목록만으로 "결과 연결(↳ vN)"을 유도할 수 있다.
 */
export interface BeArtifactVersionSummary {
  id: string;
  version_number: number;
  summary: string | null;
  created_by: string | null;
  created_at: string;
  source_comment_id: string | null;
}

export function adaptArtifactDetail(detail: BeVisualArtifactDetail): { artifact: VisualArtifact; versions: ArtifactVersion[] } {
  const format = deriveFormat(detail.nodes);
  let content: string;
  if (format === 'tree') {
    content = JSON.stringify(resolveNodeTree(detail.nodes));
  } else {
    const blob = detail.nodes.find((n) => n.type === 'html_blob');
    const key = format === 'image' ? 'src' : 'html';
    content = typeof blob?.props[key] === 'string' ? (blob.props[key] as string) : '';
  }
  const artifact: VisualArtifact = {
    id: detail.id,
    title: detail.title,
    format,
    current_version: detail.latest_version_number,
    anchor_version: detail.anchor_version,
    created_by: detail.created_by ?? '',
    source: detail.source,
    story_id: detail.story_id,
    epic_id: detail.epic_id,
    doc_id: detail.doc_id,
  };
  const version: ArtifactVersion = {
    id: `${detail.id}-v${detail.version_number}`,
    artifact_id: detail.id,
    version: detail.version_number,
    content,
    created_by: detail.created_by ?? '',
    summary: detail.version_summary,
    created_at: detail.created_at,
    canvasBounds: detail.canvas_bounds,
  };
  return { artifact, versions: [version] };
}

/**
 * story 3d888ba2 — 갤러리 변천사에서 특정 버전 실물 열람. `GET /{id}/versions/{versionNumber}`
 * 는 `[id]`(최신 버전)와 동일 shape(`BeVisualArtifactDetail`)를 버전 지정으로 반환 — 신규 BE
 * 0(이미 존재하는 엔드포인트, FE 프록시만 신설). `adaptArtifactDetail`을 그대로 재사용해
 * format/content를 뽑아낼 수 있다.
 */
export async function getArtifactVersionDetail(
  artifactId: string, versionNumber: number,
): Promise<BeVisualArtifactDetail | null> {
  try {
    const res = await fetch(`/api/visual-artifacts/${artifactId}/versions/${versionNumber}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: BeVisualArtifactDetail };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/**
 * 캔버스 휴먼 진입점(story 9449da0e) — 빈 스토리에서 "그리기" 생성 딸깍 커밋. MCP `create_artifact`와
 * **동일 BE 엔드포인트**(`POST /api/v2/visual-artifacts`·같은 서비스 `create_artifact`·신규 BE 0).
 * story 귀속 v1을 만들고 생성된 detail을 반환 — 실패는 null(호출부가 편집 모드 유지 + 로깅, 빈
 * catch 금지 계열).
 *
 * story 64010b05(C5 임포트 v1) — `source`(옵트인, 기본 생략=BE가 'created'로 기본값 채움) 추가.
 * `CreateArtifactRequest.source`는 이미 BE 계약에 존재(schemas/visual_artifact.py) — 신규 BE 0,
 * 이 함수가 그 필드를 그냥 안 보내고 있었을 뿐(그리기 호출부는 여전히 미지정 그대로 무변경).
 */
export async function createArtifact(
  storyId: string, title: string, nodes: ArtifactNode[], summary?: string, source?: 'created' | 'imported',
): Promise<BeVisualArtifactDetail | null> {
  try {
    const res = await fetch('/api/visual-artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ story_id: storyId, title, nodes, summary: summary ?? null, ...(source ? { source } : {}) }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: BeVisualArtifactDetail };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/**
 * 딸깍 편집 커밋(C3-S7 휴먼 절반) — MCP `sprintable_edit_artifact`와 **동일 BE 엔드포인트**
 * (`POST /api/v2/visual-artifacts/{id}/edit`·같은 서비스 `_apply_artifact_edit`·신규 BE 0).
 * operations diff를 적용해 새 버전을 만들고 갱신된 detail을 반환한다. `artifact.updated` 이벤트
 * 전파(휴먼↔에이전트 양방향 도달)는 BE가 수행 — FE는 배선만. 변경 0(빈 operations)이면 호출
 * 안 함(BE operations non-empty 계약·재정렬 없는 커밋 방지).
 */
export async function editArtifact(
  artifactId: string, operations: NodeOperation[], summary?: string,
): Promise<BeVisualArtifactDetail | null> {
  if (operations.length === 0) return null;
  try {
    const res = await fetch(`/api/visual-artifacts/${artifactId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations, summary: summary ?? null }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: BeVisualArtifactDetail };
    return json.data ?? null;
  } catch {
    return null;
  }
}

export const MOCK_VERSIONS: ArtifactVersion[] = [
  {
    id: 'v4', artifact_id: 'mock-artifact-1', version: 4, content: MOCK_HTML_V4,
    created_by: 'm1', summary: '버튼 위계 상향', created_at: '2026-07-10T08:00:00Z',
  },
  {
    id: 'v3', artifact_id: 'mock-artifact-1', version: 3, content: MOCK_HTML_V4,
    created_by: 'm2', summary: '승인된 계약', created_at: '2026-07-09T14:00:00Z',
  },
  {
    id: 'v2', artifact_id: 'mock-artifact-1', version: 2, content: MOCK_HTML_V4,
    created_by: 'm3', summary: '에러 카피 추가', created_at: '2026-07-08T09:00:00Z',
  },
];
