/**
 * story #3773(유나 定 2026-09-10) — `EventDefinition.stage_metadata[stage].role`이 한글
 * 화면(조직 이벤트 정의·루프 생성)에 원어(`Agent`/`PO`/`QA` 등) 그대로 노출되던 결함.
 * story #3770(원시 org 역할 값 i18n 클래스)과 같은 누출 클래스지만 어휘가 다르다 —
 * org/trust 역할 정본(`orgRoleLabel`/`resolveRoleLabel`)엔 이 값 집합이 없다.
 *
 * 프리셋 13종(`backend/alembic/versions/0260_compile_workflow_recipes_to_cycle_events.py`
 * 시드 — `_BUILTIN_RECIPES`의 리터럴 role 7종 + `_DB_RECIPES`의 `default_label` 6종, dev DB
 * 라이브 실측으로 재확認·마이그레이션으로만 늘어난다)만 i18n 정본을 거친다 — **조직 커스텀
 * 이벤트 정의의 role 값은 사용자가 직접 적은 데이터라 그대로 pass-through**(`orgRoleLabel`·
 * `resolveRoleLabel`과 동형 원칙, 새 기전 0).
 *
 * `sprintable_get_workflow_guide`(에이전트 소비 텍스트, `onboarding_guide.py`)는 이 정본을
 * 거치지 않는다 — 원어 유지가 그 축의 정본(사람 화면과 에이전트 소비 텍스트를 안 섞는다).
 */
const STAGE_ROLE_KEY: Record<string, string> = {
  Agent: 'stageRoleLabelAgent',
  Any: 'stageRoleLabelAny',
  Approver: 'stageRoleLabelApprover',
  Dev: 'stageRoleLabelDev',
  Executor: 'stageRoleLabelExecutor',
  Human: 'stageRoleLabelHuman',
  Lead: 'stageRoleLabelLead',
  Maker: 'stageRoleLabelMaker',
  Member: 'stageRoleLabelMember',
  PO: 'stageRoleLabelPo',
  QA: 'stageRoleLabelQa',
  Reviewer: 'stageRoleLabelReviewer',
  Worker: 'stageRoleLabelWorker',
};

/**
 * `Object.hasOwn`(`in` 아님) — `constructor`/`toString` 같은 값이 role로 들어오면 프로토타입
 * 사슬에 걸려 엉뚱한 키가 나오는 것을 막는다. 대소문자 정규화는 하지 않는다 — 13종은 정확히
 * 이 글자로 고정된 "우리 문구"고, 그 밖은 조직이 적은 데이터다. 데이터를 맞추려고 정규화하면
 * 없는 뜻을 지어내는 것이 된다(커스텀 값이 우연히 정확히 일치하면 그건 정확 일치라 번역돼도
 * 맞는 것 — 관대해서가 아니다).
 */
export function stageRoleLabel(role: string, t: (key: string) => string): string {
  return Object.hasOwn(STAGE_ROLE_KEY, role) ? t(STAGE_ROLE_KEY[role]!) : role;
}

// 카디르 QA 대칭 테스트가 이 집합을 BE 시드(0260)와 직접 대조한다 — 「등재≠배선」류
// 함정 방지(프리셋이 늘면 테스트가 RED, 페드루 PO 지시). 테스트 전용 export.
export const STAGE_ROLE_PRESET_VALUES = Object.freeze(Object.keys(STAGE_ROLE_KEY));
