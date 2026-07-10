/**
 * E-CANVAS C1 — 시각 산출물(visual artifact) FE 타입. blueprint `e-canvas-blueprint`(r3) §2
 * 객체 모델(초안) 미러 — BE 계약(디디 C1-S3, `visual_artifact`/`artifact_version`) 미착지 상태라
 * 이 타입/목업 데이터는 **잠정**이다. 실 API 착지 시 이 파일 타입만 계약대로 정정하면
 * 컴포넌트는 그대로 소비(props 인터페이스 유지가 목표).
 */

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
