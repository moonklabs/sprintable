/**
 * E-VERIFY V0 — 신뢰 표면(trust surface) FE 타입. BE 계약(S1/S2, PR #1994/#1995) 그대로 미러.
 * `GET /api/v2/evidence?work_item_id={id}&work_item_type=story|task` 응답 — 재조립 없이 서버 shape 그대로 소비.
 */

export type EvidenceType = 'url' | 'file' | 'pr' | 'deploy' | 'metric' | 'report' | 'gate_approval';

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  ref: string;
  source: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  org_id: string;
  work_item_id: string;
  work_item_type: 'story' | 'task';
  /** story #2722 — 아티팩트를 근거로 삼은 evidence만 채워짐. artifact_version_id가 null이면
   * 나머지 둘도 null(버전 미상 — 구 데이터 또는 아티팩트 근거 아님). */
  artifact_version_id: string | null;
  artifact_id: string | null;
  artifact_version_number: number | null;
  /** story #3560(concept_approval 검증 시트, PO 確定 2026-09-06) — type='report'일 때만
   * 뜻이 있는 kind 판별 payload(3498 generation_cost와 동형 관례 — 그 kind는 아직 이
   * 타입에 없어 여기서 처음 필드를 연다). 대부분 evidence는 undefined/null. */
  payload?: Record<string, unknown> | null;
}

/** story #3560(PO 確定 2026-09-06) — Evidence.payload.kind='verification_sheet' 형.
 * items≥1·verdict는 서버가 검증(422 EVIDENCE_PAYLOAD_INVALID) — FE는 값만 그린다. */
export interface VerificationSheetItem {
  name: string;
  verdict: 'pass' | 'fail' | 'n_a';
  note?: string | null;
}

export function asVerificationSheet(payload: Record<string, unknown> | null | undefined): VerificationSheetItem[] | null {
  if (!payload || payload['kind'] !== 'verification_sheet') return null;
  const items = payload['items'];
  if (!Array.isArray(items)) return null;
  return items as VerificationSheetItem[];
}

/**
 * story #4041(제작 작업대 — 크리에이터 에이전트 stage 산출물 계약 v0.5, doc 3cca821b §4) —
 * verification_sheet와 형제인 나머지 4개 kind. 전부 `type='report'` 재사용 + `payload.kind`
 * 서브타이핑(#4042 서버 강제 검증은 이 카드 범위 밖 — FE는 §4 확定 shape을 그대로 미러하고
 * asVerificationSheet와 동형으로 최소 구조 narrowing만 한다, 항목별 깊은 검증은 서버 책임).
 */
export interface MaterialCollectionItem {
  ref: string;
  label: string;
  tag: string;
}

export function asMaterialCollectionSheet(payload: Record<string, unknown> | null | undefined): MaterialCollectionItem[] | null {
  if (!payload || payload['kind'] !== 'material_collection_sheet') return null;
  const items = payload['items'];
  if (!Array.isArray(items)) return null;
  return items as MaterialCollectionItem[];
}

/** story #4058(doc c7991109 §3②) — material_collection_sheet payload 확장. 훅 후보를
 * `material_lineage.hook_key`가 가리키는 별도 필드(items와 공존, story #4061 AC2 — 기존
 * asMaterialCollectionSheet의 반환 shape은 안 건드린다, #4057/#4059 소비처 회귀 0). */
export interface MaterialCollectionSheetHook {
  key: string;
  text: string;
  target: string;
}

export function asMaterialCollectionSheetHooks(
  payload: Record<string, unknown> | null | undefined,
): MaterialCollectionSheetHook[] | null {
  if (!payload || payload['kind'] !== 'material_collection_sheet') return null;
  const hooks = payload['hooks'];
  if (!Array.isArray(hooks)) return null;
  return hooks as MaterialCollectionSheetHook[];
}

export interface ConceptBrief {
  concept: string;
  rationale: string;
  /** optional — 없으면 undefined(지어내지 않음, mood_refs 부재≠빈 배열). */
  mood_refs?: string[];
}

export function asConceptBrief(payload: Record<string, unknown> | null | undefined): ConceptBrief | null {
  if (!payload || payload['kind'] !== 'concept_brief') return null;
  const concept = payload['concept'];
  const rationale = payload['rationale'];
  if (typeof concept !== 'string' || typeof rationale !== 'string') return null;
  const moodRefs = payload['mood_refs'];
  return {
    concept,
    rationale,
    ...(Array.isArray(moodRefs) ? { mood_refs: moodRefs as string[] } : {}),
  };
}

export interface StoryboardShot {
  shot_no: number;
  angle: string;
  duration_sec: number;
  desc: string;
}

export interface StoryboardEmotionBeat {
  beat_no: number;
  shot_no: number;
  emotion: string;
}

export interface Storyboard {
  /** optional — 평면도 이미지 아티팩트(없으면 undefined). */
  layout_artifact_id?: string;
  shot_list: StoryboardShot[];
  emotion_beats: StoryboardEmotionBeat[];
}

export function asStoryboard(payload: Record<string, unknown> | null | undefined): Storyboard | null {
  if (!payload || payload['kind'] !== 'storyboard') return null;
  const shotList = payload['shot_list'];
  const emotionBeats = payload['emotion_beats'];
  if (!Array.isArray(shotList) || !Array.isArray(emotionBeats)) return null;
  const layoutArtifactId = payload['layout_artifact_id'];
  return {
    ...(typeof layoutArtifactId === 'string' ? { layout_artifact_id: layoutArtifactId } : {}),
    shot_list: shotList as StoryboardShot[],
    emotion_beats: emotionBeats as StoryboardEmotionBeat[],
  };
}

export type AnimaticCostTier = 'no_charge' | 'paid';

export interface Animatic {
  artifact_id: string;
  cost_tier: AnimaticCostTier;
  duration_sec: number;
}

export function asAnimatic(payload: Record<string, unknown> | null | undefined): Animatic | null {
  if (!payload || payload['kind'] !== 'animatic') return null;
  const artifactId = payload['artifact_id'];
  const costTier = payload['cost_tier'];
  const durationSec = payload['duration_sec'];
  if (typeof artifactId !== 'string') return null;
  if (costTier !== 'no_charge' && costTier !== 'paid') return null;
  if (typeof durationSec !== 'number') return null;
  return { artifact_id: artifactId, cost_tier: costTier, duration_sec: durationSec };
}

/** #4041 §3 stage→kind 매핑 순서(소재 수집→컨셉→스토리보드→애니매틱→발행 前 검증) 그대로 —
 * 제작 작업대 화면이 이 순서로 정렬해 보여줄 때 재사용(정의 시점 SSOT, 하드코딩 재사용 방지). */
export const PRODUCTION_WORKBENCH_KIND_ORDER = [
  'material_collection_sheet', 'concept_brief', 'storyboard', 'animatic', 'verification_sheet',
] as const;

export type ProductionWorkbenchKind = (typeof PRODUCTION_WORKBENCH_KIND_ORDER)[number];

/** payload.kind 문자열만으로 이 evidence가 제작 작업대 산출물인지 판별(narrowing 없이 빠른
 * 필터용 — 실제 shape 확認은 위 asXxx로). 미등재 kind는 #4042 서버 방어선 대기 상태라
 * false(이 축이 아직 다루는 5종 밖은 여기서 안 챙긴다, 지어내지 않음). */
export function isProductionWorkbenchKind(kind: unknown): kind is ProductionWorkbenchKind {
  return typeof kind === 'string' && (PRODUCTION_WORKBENCH_KIND_ORDER as readonly string[]).includes(kind);
}

/**
 * E-VERIFY P0-04 — claimed-vs-verified-spec-handoff §3 BE 계약(PR #2069) 미러. `has_evidence`
 * (1 boolean, self-report와 human-verified를 뭉갬)를 대체하는 2신호 — story/task 응답에 그대로
 * 동봉. null=미측정(0건), false는 오지 않음(BE 계약).
 */
export interface TrustSignal {
  self_reported?: boolean | null;
  human_verified?: boolean | null;
  human_verified_by?: string | null;
  human_verified_at?: string | null;
}

export type TrustStage = 'claimed' | 'verified' | null;

/**
 * claimed-vs-verified-spec-handoff §3 파생 규칙 그대로: human_verified→verified(green)·
 * self_reported & !human_verified→claimed(amber)·!self_reported→무표시(null, D-03 완료 기준).
 */
export function deriveTrustStage(signal: TrustSignal): TrustStage {
  if (signal.human_verified) return 'verified';
  if (signal.self_reported) return 'claimed';
  return null;
}

const _TERMINAL_GATE_STATUSES = new Set(['approved', 'rejected', 'voided']);

/**
 * story #2893(설계안 §2 A1) — 한 스토리에 merge 게이트가 여러 개(PR마다 1개)일 수 있게 됐다.
 * "이 스토리의 merge 게이트"를 단건으로 보여주는 화면(StoryMergeGate·Workcell Evidence
 * 구획)이 이제 «어느 PR 것을 보여줄지» 골라야 한다 — 옛 `.find(g => g.gate_type==='merge')`
 * (배열의 첫 번째, 삽입순=사실상 무작위)를 대체.
 *
 * 우선순위: ①미종결(pending/auto_passed/held — 지금 사람 눈이 필요한 것)이 종결(approved/
 * rejected/voided)보다 우선 ②동순위 중엔 pr_number가 큰 쪽(가장 최근 열린 PR으로 근사).
 * pr_number가 없는(레거시/PR 컨텍스트 없음) 게이트는 항상 최하순위(0 취급, 실 PR 정보가
 * 있는 쪽을 우선 — 지어내지 않되 있으면 쓴다).
 */
export function pickRelevantMergeGate<G extends { gate_type: string; status: string; pr_number?: number | null }>(
  gates: G[],
): G | undefined {
  const mergeGates = gates.filter((g) => g.gate_type === 'merge');
  if (mergeGates.length === 0) return undefined;
  const sorted = [...mergeGates].sort((a, b) => {
    const aOpen = _TERMINAL_GATE_STATUSES.has(a.status) ? 0 : 1;
    const bOpen = _TERMINAL_GATE_STATUSES.has(b.status) ? 0 : 1;
    if (aOpen !== bOpen) return bOpen - aOpen; // 미종결 먼저.
    return (b.pr_number ?? 0) - (a.pr_number ?? 0); // 큰 pr_number(최근 PR) 먼저.
  });
  return sorted[0];
}
