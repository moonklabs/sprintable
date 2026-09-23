import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  expandRoleSlotBindings, groupStagesByRole, orderedRecipeRoles, recipeConnectionTargets, recipeKeyDomain,
  recipeRoleSlots, roleActorKind, stagesInFlowOrder, stagesWithCapability, stagesWithGate, type RecipeStageMetadata,
} from './recipe-role-slots';
import { VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE } from './video-production-seed.test.fixture';

// PO 判定(2026-09-18, story #4046 AC 업데이트) — 마케팅 레시피의 role_mapping
// (recipe_role_bindings) 바인딩 대상은 «크리에이터» 하나뿐(표시 문구 — 내부 데이터 키는
// 아래 참고). 디렉터=게이트 승인 주체(stagesWithGate)·연산=capability(stagesWithCapability)·
// 발행자=채널 타깃(후속 카드, 이 파일 밖) — 셋 다 role_mapping 축이 아니다.
const BINDABLE_ROLES = ['Creator'] as const;

// story #4426 P1 교훈 그대로 — 실 seed 모양(영어 role 키)과만 대조한다. story #4173부터는
// 손으로 옮긴 축소판 대신 dev 실 정의(version 8) 한 벌(video-production-seed.test.fixture.ts)을
// 공유한다(옛 축소판은 그새 추가된 게이트·capability.target·role_actor_kinds를 놓치고 있었다).
const MARKETING_VIDEO_PRODUCTION_STAGE_METADATA: RecipeStageMetadata = VIDEO_PRODUCTION_RECIPE.stage_metadata;

describe('groupStagesByRole — #4039/#4419 실 착지 seed(0381) stage_metadata 기준', () => {
  it('9 stage가 role 키 4종(Creator·Director·Compute·Publisher)으로 정확히 갈린다', () => {
    const groups = groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(Object.keys(groups).sort()).toEqual(['Compute', 'Creator', 'Director', 'Publisher']);
    // 그룹 안 순서는 stage_metadata 키 순서(API 응답 순서) — 흐름 순서는 stagesInFlowOrder가 따로.
    expect(groups['Director']).toEqual(['pending_approval', 'structure_passed', 'concept_confirmed']);
    expect(groups['Creator']).toEqual(['draft', 'editing', 'animatic', 'verification']);
    expect(groups['Compute']).toEqual(['live_generation']);
    expect(groups['Publisher']).toEqual(['published']);
  });

  it('role 없는 stage는 그룹에서 빠진다(신호형/측정형 정의의 빈 stage_metadata 등)', () => {
    const groups = groupStagesByRole({ x: { action: 'no role' }, y: {} });
    expect(groups).toEqual({});
  });

  it('한글 표시라벨("크리에이터" 등)은 이 fixture의 어떤 role 키와도 안 맞는다 — #4426 결함이 정확히 이 자리(회귀 pin)', () => {
    const groups = groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(groups['크리에이터']).toBeUndefined();
  });
});

describe('expandRoleSlotBindings — bindableRoles 화이트리스트 밖 role은 강제로 걸러진다', () => {
  it('Creator 선택만 그 role의 4 stage를 채운다(유일한 role_mapping-eligible 축) — #4426 핵심 회귀', () => {
    const roleMapping = expandRoleSlotBindings(
      MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, BINDABLE_ROLES, { Creator: 'member-creator' },
    );
    // 수정 前(한글 라벨)이었다면 이 결과가 항상 {}였다 — role_mapping이 실제로 채워지는지가
    // 이 P1의 근본 pin이다.
    expect(roleMapping).toEqual({
      draft: 'member-creator', animatic: 'member-creator',
      verification: 'member-creator', editing: 'member-creator',
    });
  });

  it('Director·Publisher 선택은 bindableRoles에 없으면 조용히 무시된다(PO 判定 2026-09-18)', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, BINDABLE_ROLES, {
      Director: 'member-director', Creator: 'member-creator', Publisher: 'member-publisher',
    });
    expect(Object.keys(roleMapping).sort()).toEqual(['animatic', 'draft', 'editing', 'verification']);
    expect(roleMapping.concept_confirmed).toBeUndefined();
    expect(roleMapping.pending_approval).toBeUndefined();
  });

  it('bindableRoles를 넓히면(호출부가 명시적으로 그렇게 하지 않는 한) 그 role도 펼쳐진다 — 화이트리스트가 유일한 관문', () => {
    const roleMapping = expandRoleSlotBindings(
      MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, ['Creator', 'Director'], {
        Creator: 'member-creator', Director: 'member-director',
      },
    );
    expect(roleMapping.concept_confirmed).toBe('member-director');
    expect(roleMapping.draft).toBe('member-creator');
  });

  it('빈 문자열 선택·존재하지 않는 role 키는 무시된다(연산 슬롯을 selections에 줘도 안전)', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, BINDABLE_ROLES, {
      Creator: '', Compute: 'member-compute',
    });
    expect(roleMapping).toEqual({});
  });
});

describe('stagesWithCapability — role과 독립인 인프라/커넥터 축', () => {
  it('capability를 선언한 stage 4곳(attach_video 2·generate·publish)을 뽑는다', () => {
    const stages = stagesWithCapability(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(stages.map((s) => [s.stage, s.role, s.capability.kind])).toEqual([
      ['editing', 'Creator', 'attach_video'],
      ['published', 'Publisher', 'publish'],
      ['verification', 'Creator', 'attach_video'],
      ['live_generation', 'Compute', 'generate'],
    ]);
  });
});

describe('stagesWithGate — 게이트 승인 주체 축(role_mapping과 분리, PO 判定 2026-09-18)', () => {
  it('gate를 선언한 stage 4곳(구조·발행·예산·컨셉)을 approver 그대로 뽑는다', () => {
    const stages = stagesWithGate(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(stages.map((s) => [s.stage, s.role, s.gate.type, s.gate.approver])).toEqual([
      ['animatic', 'Creator', 'structure_approval', 'org_owner'],
      ['pending_approval', 'Director', 'external_publish', 'org_owner'],
      ['structure_passed', 'Director', 'generation_budget', 'org_owner'],
      ['concept_confirmed', 'Director', 'concept_approval', 'org_owner'],
    ]);
  });
});

describe('recipeKeyDomain — preset.{domain}.{slug} 둘째 세그먼트 축(#4039 PR 설계정정)', () => {
  it('preset.marketing.* → "marketing"', () => {
    expect(recipeKeyDomain('preset.marketing.video_production')).toBe('marketing');
  });

  it('preset.workflow.* → "workflow"(개발 워크플로, 마케팅과 분리되는 대조군)', () => {
    expect(recipeKeyDomain('preset.workflow.some_slug')).toBe('workflow');
  });

  it('preset. 접두 없는 org 커스텀 정의 key(예: org.acme.widget_made) → null', () => {
    expect(recipeKeyDomain('org.acme.widget_made')).toBeNull();
  });
});

describe('roleActorKind — story #4092(§b) 정의 선언 role_actor_kinds 리더', () => {
  const KINDS = { Creator: 'agent', Director: 'human' } as const;

  it('선언된 role은 그 값을 그대로 반환한다', () => {
    expect(roleActorKind('Creator', KINDS)).toBe('agent');
    expect(roleActorKind('Director', KINDS)).toBe('human');
  });

  it('선언 안에 없는 role명은 지어내지 않고 null("모름")', () => {
    expect(roleActorKind('Compute', KINDS)).toBeNull();
  });

  it('role_actor_kinds 자체가 없으면(정의가 선언 안 함) null', () => {
    expect(roleActorKind('Director', null)).toBeNull();
    expect(roleActorKind('Director', undefined)).toBeNull();
  });

  it('role이 없으면(undefined) null', () => {
    expect(roleActorKind(undefined, KINDS)).toBeNull();
  });
});

// ── story #4173 — 정의로 구동하는 역할 순서·자리·연결 ─────────────────────────────

describe('stagesInFlowOrder — 흐름 순서는 payload_schema enum이 정본', () => {
  it('실 seed의 stage_metadata 키 순서(API 저장 순서)와 무관하게 enum 순서로 편다', () => {
    expect(stagesInFlowOrder(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW)).toEqual([...VIDEO_PRODUCTION_FLOW]);
  });

  it('enum에 없는 stage는 stage_metadata 순서대로 뒤에 붙는다', () => {
    expect(stagesInFlowOrder({ b: { role: 'X' }, extra: { role: 'Y' }, a: { role: 'X' } }, ['a', 'b'])).toEqual(['a', 'b', 'extra']);
  });
});

describe('orderedRecipeRoles — 카드·적용 다이얼로그 공용 순서(사람 먼저 → 흐름 순서)', () => {
  it('영상 레시피 = Director · Creator · Compute · Publisher', () => {
    expect(orderedRecipeRoles(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE.role_actor_kinds))
      .toEqual(['Director', 'Creator', 'Compute', 'Publisher']);
  });

  it('role_actor_kinds가 없으면 흐름 순서 그대로(사람을 추측하지 않는다)', () => {
    expect(orderedRecipeRoles(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, null))
      .toEqual(['Creator', 'Director', 'Compute', 'Publisher']);
  });
});

describe('recipeRoleSlots — 역할마다 메커니즘 판별', () => {
  it('영상 레시피 4자리 — approver·member·compute·channel, 채우는 stage는 흐름 순서', () => {
    const slots = recipeRoleSlots(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE.role_actor_kinds);
    expect(slots.map((s) => [s.role, s.kind, s.stages])).toEqual([
      ['Director', 'approver', ['concept_confirmed', 'structure_passed', 'pending_approval']],
      ['Creator', 'member', ['draft', 'animatic', 'verification', 'editing']],
      ['Compute', 'compute', ['live_generation']],
      ['Publisher', 'channel', ['published']],
    ]);
    expect(slots[0]!.gateApprovers).toEqual(['org_owner', 'org_owner', 'org_owner']);
  });

  it('선언이 없으면 모든 stage가 게이트인 역할만 승인 자리, 나머지는 멤버 자리', () => {
    const slots = recipeRoleSlots({
      draft: { role: 'Writer' },
      review: { role: 'Editor', gate: { type: 'doc_approval', approver: 'org_owner' } },
    }, ['draft', 'review'], null);
    expect(slots.map((s) => [s.role, s.kind])).toEqual([['Writer', 'member'], ['Editor', 'approver']]);
  });

  it('게이트 없는 사람 역할은 사람 멤버 자리다(읽기 전용이 아니다)', () => {
    const slots = recipeRoleSlots({ draft: { role: 'Writer' } }, ['draft'], { Writer: 'human' });
    expect(slots).toEqual([{ role: 'Writer', kind: 'member', stages: ['draft'], memberType: 'human', gateApprovers: [] }]);
  });
});

describe('recipeConnectionTargets — 카드 «연결» 행의 원천(필수 먼저, 한 표)', () => {
  it('영상 레시피 = 발행 채널(필수) → 연산 커넥터(선택)', () => {
    expect(recipeConnectionTargets(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA)).toEqual([
      { target: 'channel_connection', optional: false },
      { target: 'generation_connector', optional: true },
    ]);
  });

  it('agent·미지정 target은 연결이 아니라 빠지고, 없으면 빈 배열', () => {
    expect(recipeConnectionTargets({ a: { role: 'X', capability: { kind: 'x', target: 'agent' } }, b: { role: 'X' } })).toEqual([]);
  });
});

// AC2 — 레시피 종류에 묶인 상수(예: 예전 MARKETING_CREATOR_ROLE_KEY)·호출부가 넘기던
// creatorRoleLabel이 소스에서 사라졌는지(소비처 0) 단언한다.
describe('레시피 전용 상수 소비처 0(story #4173 AC2)', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) return sources(full);
      return /\.tsx?$/.test(e) && full !== __filename ? [full] : [];
    });
  }

  it('MARKETING_CREATOR_ROLE_KEY·creatorRoleLabel 참조가 apps/web/src 어디에도 없다', () => {
    const hits = sources(join(__dirname, '..'))
      .filter((f) => /MARKETING_CREATOR_ROLE_KEY|creatorRoleLabel/.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
