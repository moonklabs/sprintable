/**
 * E-WORKFLOW-CONTRACT — 원자 조건 타입 세트
 *
 * 유한한 원자 조건 타입으로 무한한 계약을 표현한다.
 * escape hatch(custom_fn) 없음. 모든 조건은 순수하다(부작용 없음).
 *
 * 조합: AllOf(AND) / AnyOf(OR) / NoneOf(NOT) 를 통해 복합 gate를 구성한다.
 * definition(jsonb) 구조:
 *   { states, initial_state, transitions: [{ from, to, on_tool, gate }] }
 */

// ─── Entity / Caller references ───────────────────────────────────────────────

/** 내장 PM 엔티티 종류 */
export type KnownEntityType = 'story' | 'sprint' | 'epic' | 'task' | 'document' | 'retro_session';

/**
 * 상태 머신이 평가할 엔티티 종류.
 * KnownEntityType 외에 커스텀 도메인(order, article, candidate 등)을 string으로 허용한다. (AC1, AC2)
 */
export type WorkflowEntityType = KnownEntityType | (string & {});

// ─── Atomic condition types (20종) ────────────────────────────────────────────

/** field가 존재하는지(null/undefined가 아닌지) */
export interface CondFieldExists    { type: 'field_exists';    entity: WorkflowEntityType; field: string }
/** field가 비어있지 않은지 (string: length>0, array: length>0, number: defined) */
export interface CondFieldNotEmpty  { type: 'field_not_empty'; entity: WorkflowEntityType; field: string }
/** field 값이 특정 값과 같은지 */
export interface CondFieldEquals    { type: 'field_equals';    entity: WorkflowEntityType; field: string; value: string | number | boolean }
/** field 값이 특정 값과 다른지 */
export interface CondFieldNotEquals { type: 'field_not_equals'; entity: WorkflowEntityType; field: string; value: string | number | boolean }
/** field 값이 values 목록 안에 있는지 */
export interface CondFieldIn        { type: 'field_in';        entity: WorkflowEntityType; field: string; values: Array<string | number> }
/** array field의 원소 수가 n 이상인지 */
export interface CondFieldMinCount  { type: 'field_min_count'; entity: WorkflowEntityType; field: string; n: number }
/** array field의 원소 수가 n 이하인지 */
export interface CondFieldMaxCount  { type: 'field_max_count'; entity: WorkflowEntityType; field: string; n: number }
/** field 문자열이 정규식에 매칭되는지 */
export interface CondFieldMatchesRegex { type: 'field_matches_regex'; entity: WorkflowEntityType; field: string; pattern: string }
/** boolean field가 true인지 */
export interface CondBoolIsTrue     { type: 'bool_is_true';    entity: WorkflowEntityType; field: string }
/** boolean field가 false인지 */
export interface CondBoolIsFalse    { type: 'bool_is_false';   entity: WorkflowEntityType; field: string }
/** 엔티티의 status가 특정 값과 같은지 */
export interface CondStatusEquals   { type: 'status_equals';   entity: WorkflowEntityType; status: string }
/** 엔티티의 status가 statuses 목록 안에 있는지 */
export interface CondStatusIn       { type: 'status_in';       entity: WorkflowEntityType; statuses: string[] }
/** 호출자의 role이 특정 role인지 */
export interface CondRoleIs         { type: 'role_is';         caller: 'actor' | 'assignee' | 'owner'; role: string }
/** 호출자의 role이 roles 목록 안에 있는지 */
export interface CondRoleIn         { type: 'role_in';         caller: 'actor' | 'assignee' | 'owner'; roles: string[] }
/** since_event로부터 duration이 경과했는지 (ISO 8601 duration: "PT1H", "P7D") */
export interface CondTimeElapsed    { type: 'time_elapsed';    since_event: string; duration: string }
/** entity.field 날짜가 deadline(ISO datetime or duration) 이전인지 */
export interface CondTimeBefore     { type: 'time_before';     entity: WorkflowEntityType; field: string; deadline: string }
/** entity.field가 참조하는 외부 엔티티가 유효한지 (존재 + 삭제되지 않음) */
export interface CondReferenceValid { type: 'reference_valid'; entity: WorkflowEntityType; field: string }
/** entity를 filter 조건으로 조회했을 때 count >= n */
export interface CondCountGte       { type: 'count_gte';       entity: WorkflowEntityType; filter: Record<string, unknown>; n: number }
/** entity를 filter 조건으로 조회했을 때 count <= n */
export interface CondCountLte       { type: 'count_lte';       entity: WorkflowEntityType; filter: Record<string, unknown>; n: number }
/** entity를 filter 조건으로 조회했을 때 count === n */
export interface CondCountEquals    { type: 'count_equals';    entity: WorkflowEntityType; filter: Record<string, unknown>; n: number }

/** 20종 원자 조건 Union */
export type AtomicCondition =
  | CondFieldExists | CondFieldNotEmpty | CondFieldEquals | CondFieldNotEquals | CondFieldIn
  | CondFieldMinCount | CondFieldMaxCount | CondFieldMatchesRegex
  | CondBoolIsTrue | CondBoolIsFalse
  | CondStatusEquals | CondStatusIn
  | CondRoleIs | CondRoleIn
  | CondTimeElapsed | CondTimeBefore
  | CondReferenceValid
  | CondCountGte | CondCountLte | CondCountEquals;

// ─── Composite gate (AND / OR / NOT) ──────────────────────────────────────────

export type GateExpression =
  | AtomicCondition
  | { type: 'all_of'; conditions: GateExpression[] }   // AND
  | { type: 'any_of'; conditions: GateExpression[] }   // OR
  | { type: 'none_of'; conditions: GateExpression[] }; // NOT (none must be true)

// ─── Contract definition (jsonb) ──────────────────────────────────────────────

export interface WorkflowTransition {
  from: string;
  to: string;
  on_tool: string;       // MCP 도구 이름
  gate?: GateExpression; // 전환 허용 조건 (없으면 무조건 허용)
}

export interface WorkflowContractDefinition {
  states: string[];
  initial_state: string;
  transitions: WorkflowTransition[];
  terminal_states?: string[];  // 명시적 종료 상태. 없으면 전환 없는 상태가 deadlock으로 감지됨
}

// ─── DB record shapes ──────────────────────────────────────────────────────────

export type WorkflowMode = 'evaluate' | 'enforce';
export type WorkflowInstanceStatus = 'active' | 'completed' | 'cancelled';

export interface WorkflowContractRecord {
  id: string;
  org_id: string;
  name: string;
  version: number;
  mode: WorkflowMode;
  definition: WorkflowContractDefinition;
  entity_type: WorkflowEntityType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkflowInstanceRecord {
  id: string;
  contract_id: string;
  entity_id: string;
  current_state: string;
  context: Record<string, unknown>;
  status: WorkflowInstanceStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkflowEventRecord {
  id: string;
  instance_id: string;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor_id: string | null;
  tool_name: string | null;
  details: Record<string, unknown>;
  created_at: string;
}
