import { describe, expect, it } from 'vitest';
import { STAGE_ROLE_PRESET_VALUES, stageRoleLabel } from './stage-role';

// story #3773 — 프리셋 13종(backend/alembic/versions/
// 0260_compile_workflow_recipes_to_cycle_events.py 시드 — 유나 재확認 2026-09-10, dev DB
// 라이브 실측과 정확히 일치). 이 목록이 그 시드와 어긋나면(늘거나 줄면) RED — 「등재≠배선」
// 함정 방지(페드루 PO 지시).
const BE_SEED_PRESET_VALUES = [
  'Agent', 'Any', 'PO', 'Human', 'Dev', 'Lead', 'QA', // _BUILTIN_RECIPES 리터럴
  'Worker', 'Maker', 'Reviewer', 'Executor', 'Approver', 'Member', // _DB_RECIPES default_label
];

function t(key: string): string {
  const map: Record<string, string> = {
    stageRoleLabelAgent: '에이전트', stageRoleLabelAny: '누구나', stageRoleLabelApprover: '승인자',
    stageRoleLabelDev: '개발자', stageRoleLabelExecutor: '실행자', stageRoleLabelHuman: '사람',
    stageRoleLabelLead: '리드', stageRoleLabelMaker: '제작자', stageRoleLabelMember: '구성원',
    stageRoleLabelPo: 'PO', stageRoleLabelQa: 'QA', stageRoleLabelReviewer: '검토자',
    stageRoleLabelWorker: '작업자',
  };
  return map[key] ?? `[missing:${key}]`;
}

describe('stageRoleLabel — story #3773', () => {
  // ⭐되돌리면 RED — BE 시드(0260)와 FE 룩업 집합이 정확히 대칭이어야 한다. 프리셋이
  // 늘면(마이그레이션 추가) 이 테스트가 잡는다 — 사람이 손으로 잊지 않게.
  it('⭐FE 룩업 키 집합이 BE 시드(0260) 프리셋 13종과 정확히 대칭이다', () => {
    expect(new Set(STAGE_ROLE_PRESET_VALUES)).toEqual(new Set(BE_SEED_PRESET_VALUES));
    expect(STAGE_ROLE_PRESET_VALUES.length).toBe(13);
  });

  it('프리셋 13종 전부 t()를 거쳐 번역된 낱말을 낸다(원어 그대로 새지 않는다)', () => {
    const expected: Record<string, string> = {
      Agent: '에이전트', Any: '누구나', Approver: '승인자', Dev: '개발자', Executor: '실행자',
      Human: '사람', Lead: '리드', Maker: '제작자', Member: '구성원', PO: 'PO', QA: 'QA',
      Reviewer: '검토자', Worker: '작업자',
    };
    for (const [role, label] of Object.entries(expected)) {
      expect(stageRoleLabel(role, t)).toBe(label);
    }
  });

  it('⭐조직 커스텀 값(프리셋 밖)은 원어 그대로 pass-through — 지어내지 않는다', () => {
    expect(stageRoleLabel('마케터', t)).toBe('마케터');
    expect(stageRoleLabel('CustomOwner', t)).toBe('CustomOwner');
  });

  // ⭐되돌리면 RED — `in` 연산자로 되돌리면 프로토타입 체인의 값(예: toString)이
  // «걸려» 엉뚱한 동작을 한다. Object.hasOwn만이 이걸 막는다.
  it('⭐프로토타입 체인 값(constructor/toString 등)은 프리셋으로 오판되지 않는다', () => {
    expect(stageRoleLabel('constructor', t)).toBe('constructor');
    expect(stageRoleLabel('toString', t)).toBe('toString');
    expect(stageRoleLabel('hasOwnProperty', t)).toBe('hasOwnProperty');
  });

  it('대소문자를 정규화하지 않는다 — "agent"(소문자)는 데이터로서 그대로 pass-through', () => {
    expect(stageRoleLabel('agent', t)).toBe('agent');
    expect(stageRoleLabel('AGENT', t)).toBe('AGENT');
  });
});
