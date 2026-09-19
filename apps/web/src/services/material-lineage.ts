/**
 * story #4058(에셋 계보 + 소재·훅 단위 성과 회수 — 데이터 모델 계약, doc c7991109 v3 finalize,
 * 미르코) FE 타입 미러. `material_lineage` 테이블은 코드-前 계약 단계다(doc §5 next-step
 * 2·4 — 마이그레이션·집계 함수 미착지) — 이 파일은 그 계약의 shape만 미러하고, 이 shape을
 * 채울 API 엔드포인트는 아직 없다(story #4061 AC5 — fetching 훅은 이 카드가 안 만든다).
 */

// doc §3① CHECK 후보(디디 계보 UI 요구 대조 결과 — story #4061 §4③ 답변, 3종 그대로 채택).
export type RelationKind = 'platform_cut' | 'aspect_adapt' | 'hook_variant';

// doc §3① — insight_snapshots.publication_kind와 동형인 다형 축(derived_kind+derived_id).
export type DerivedKind = 'channel_post_draft' | 'channel_publication';

/** doc §3① `material_lineage` 테이블 컬럼 그대로 미러. FK 없는 축(source_evidence_id·
 * derived_id·hook_key)은 서버 원문 그대로 uuid/string 문자열로 받는다(도메인 전역 관례 —
 * evidence.py·insight_snapshots.py와 동형, 클라이언트가 참조 무결성을 새로 짓지 않는다). */
export interface MaterialLineageEdge {
  id: string;
  org_id: string;
  project_id: string | null;
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
  created_by: string | null;
  created_at: string;
}

/** doc §3③ compute_hook_performance()의 반환 shape 미러. insight_snapshots.py 기존
 * NORMALIZED_KEYS(7+3키)를 그대로 재사용한다는 계약 문장만 확定됐고, 그 정확한 키 목록·
 * 정의는 아직 코드로 안 드러나 있어(compute_hook_performance 자체가 미구현, doc §5-4) 여기서
 * 각 필드를 지어내지 않는다 — 값은 `Record<string, number | null>`로 열어 두고(null=미측정,
 * insight_snapshots 관례 그대로), hook_key·집계 대상 건수만 확定 필드로 둔다. 실 구현이
 * 착지하면 이 Record를 구체 키로 좁히는 게 후속(story #4061 §5 next-step, 이 카드 범위 밖). */
export interface HookPerformanceSummary {
  hook_key: string;
  /** 이 hook_key로 집계된 material_lineage 매치 건수(work_item_id 집합 크기) — 0이면
   * "아직 아무 변주도 이 훅을 안 씀"(집계 실패와 다름, no-fiction). */
  matched_lineage_count: number;
  metrics: Record<string, number | null>;
}
