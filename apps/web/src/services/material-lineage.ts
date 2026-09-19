/**
 * story #4058(에셋 계보 + 소재·훅 단위 성과 회수, doc c7991109 v3 finalize, 미르코) FE 타입.
 * PR #4434(backend/app/routers/material_lineage.py) 실 응답 shape 그대로 미러 — DB 모델
 * 컬럼 전체가 아니라 그 라우터의 response_model(MaterialLineageEdgeView/HookPerformanceView)
 * 만 미러한다(org_id/project_id/created_by/created_at은 API가 안 내려줌, 지어내지 않음).
 */

// doc §3① — insight_snapshots.publication_kind와 동형인 다형 축(derived_kind+derived_id).
export type DerivedKind = 'channel_post_draft' | 'channel_publication';

// GET /api/v2/material-lineage?work_item_id= 의 CHECK 후보(디디 계보 UI 요구 대조 결과 —
// story #4061 §4③ 답변, 3종 그대로 채택).
export type RelationKind = 'platform_cut' | 'aspect_adapt' | 'hook_variant';

/** `GET /api/v2/material-lineage?work_item_id=` 응답 항목(`MaterialLineageEdgeView`,
 * PR #4434) 그대로 미러. FK 없는 축(source_evidence_id·derived_id·hook_key)은 서버 원문
 * 그대로 uuid 문자열로 받는다(evidence.py·insight_snapshots.py와 동형 관례). */
export interface MaterialLineageEdge {
  id: string;
  /** 마스터 material — evidence.id(type="url"·ref="live-run:master-cut", doc §1⑥). */
  source_evidence_id: string;
  derived_kind: DerivedKind;
  derived_id: string;
  relation_kind: RelationKind;
  /** relation_kind='platform_cut'일 때만 채워짐('reels'|'shorts'|'ads' 등, doc §3① — 값
   * 집합이 CHECK로 고정되지 않아 여기서도 임의 문자열로 남긴다, 새 플랫폼 추가 시 코드 변경
   * 불요가 이 열린 타입의 이유). */
  variant_axis: string | null;
  /** doc §3② material_collection_sheet payload의 hooks[].key를 가리킨다(FK 아님). */
  hook_key: string | null;
  work_item_id: string;
  /** story #4435 갭2 후속(PR #4434, backend/app/routers/material_lineage.py 실 착지 필드) —
   * Story.title(gates.py::_resolve_work_item_summary 재사용, fail-soft) 미러. 한 목록 안
   * 모든 edge가 같은 work_item_id를 공유해 같은 값이 중복 실린다(서버 코멘트 그대로) —
   * 조회 실패 시 null(지어내지 않음, uuid로 폴백은 렌더층 책임). */
  master_title: string | null;
  /** story #4435 갭2 후속 — channel_post_draft/channel_publication의 denorm `channel`
   * 컬럼 반사(새 join 0). null=그 derived_id 조회 실패(교차조직 등, fail-soft). */
  channel: string | null;
}

/** `GET /api/v2/material-lineage/hook-performance?hook_key=` 응답(`HookPerformanceView`,
 * PR #4434 backend/app/services/material_lineage.py::compute_hook_performance 그대로
 * 미러). `totals`의 각 키는 insight_snapshots.py NORMALIZED_KEYS — 그 정확한 키 목록을
 * FE가 하드코딩하지 않는다(BE SoT, 재사용 원칙 그대로 — 새 성과 키를 FE가 발명하지 않음).
 * null≠0(house 관례) — 그 키를 실제로 측정한 snapshot이 하나도 없으면 None. */
export interface HookPerformanceSummary {
  hook_key: string;
  /** hook_key로 매치된 lineage row 총수(초안 포함, 발행 여부 무관) — 0이면 "아직 아무
   * 변주도 이 훅을 안 씀"(집계 실패와 다름, no-fiction). */
  variant_count: number;
  /** 실제 성과 합산에 쓰인 insight_snapshots(status='captured') 건수 — variant_count보다
   * 작을 수 있다(미발행 변주·미집계 snapshot 존재). */
  snapshot_count: number;
  totals: Record<string, number | null>;
}
