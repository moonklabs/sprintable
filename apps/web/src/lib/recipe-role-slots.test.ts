import { describe, expect, it } from 'vitest';
import {
  expandRoleSlotBindings, groupStagesByRole, MARKETING_CREATOR_ROLE_KEY, recipeKeyDomain,
  roleActorKind, stagesWithCapability, stagesWithGate, type RecipeStageMetadata,
} from './recipe-role-slots';

// PO 判定(2026-09-18, story #4046 AC 업데이트) — 마케팅 레시피의 role_mapping
// (recipe_role_bindings) 바인딩 대상은 «크리에이터» 하나뿐(표시 문구 — 내부 데이터 키는
// 아래 참고). 디렉터=게이트 승인 주체(stagesWithGate)·연산=capability(stagesWithCapability)·
// 발행자=채널 타깃(후속 카드, 이 파일 밖) — 셋 다 role_mapping 축이 아니다.
const BINDABLE_ROLES = [MARKETING_CREATOR_ROLE_KEY] as const;

// story #4426 P1(카디르 실 시드 E2E 재현, 2026-09-19) — 이 fixture는 이전엔 한글 role
// 라벨("크리에이터"/"디렉터"/"발행자")을 썼다. #4039(PR #4419)가 착지하기 前 작성된 추측
// 값이었는데, 실제 착지한 backend/alembic/versions/0381_preset_marketing_video_production_
// recipe.py의 _STAGE_METADATA는 **영어 role 키**("Creator"/"Director"/"Compute"/
// "Publisher")를 쓴다 — 이 드리프트를 아무 테스트도 못 잡아(고립fixture가 스스로 만든
// 값과만 대조했으므로, [합성표본=구조숨김]) MARKETING_CREATOR_ROLE_KEY가 실 seed와 어긋난
// 채(구 이름 MARKETING_CREATOR_ROLE_LABEL='크리에이터') 크리에이터 배정이 전부 조용히
// no-op이 되는 P1 결함으로 이어졌다(#4426 qa:changes). 아래는 그 실제 seed 값을 문자
// 그대로 옮긴 것 — 이제부터 이 fixture가 곧 "실 시드 계약 위반 감지기"다.
const MARKETING_VIDEO_PRODUCTION_STAGE_METADATA: RecipeStageMetadata = {
  draft: { role: 'Creator', action: '로그라인·매핑표·컨셉 초안 작성' },
  concept_confirmed: {
    role: 'Director', action: '우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인',
    gate: { type: 'concept_approval', approver: 'org_owner' },
  },
  animatic: { role: 'Creator', action: '무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청' },
  structure_passed: { role: 'Director', action: '구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인' },
  live_generation: {
    role: 'Compute', action: '실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출',
    capability: { kind: 'generate' },
  },
  verification: { role: 'Creator', action: '프레임8+받아쓰기 등 눈·귀 검증 시트 작성' },
  editing: { role: 'Creator', action: '편집 통일 패스(그레이드·룸톤·자막 레벨 통일)' },
  pending_approval: {
    role: 'Director', action: '최종 발행 승인(외부 발행 직전)',
    gate: { type: 'external_publish', approver: 'org_owner' },
  },
  published: { role: 'Publisher', action: '승인된 채널에 실 게시', capability: { kind: 'publish' } },
};

describe('groupStagesByRole — #4039/#4419 실 착지 seed(0381) stage_metadata 기준', () => {
  it('9 stage가 role 키 4종(Creator·Director·Compute·Publisher)으로 정확히 갈린다', () => {
    const groups = groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(Object.keys(groups).sort()).toEqual(['Compute', 'Creator', 'Director', 'Publisher']);
    expect(groups['Director']).toEqual(['concept_confirmed', 'structure_passed', 'pending_approval']);
    expect(groups['Creator']).toEqual(['draft', 'animatic', 'verification', 'editing']);
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

describe('MARKETING_CREATOR_ROLE_KEY — 실 seed와의 계약(#4426 P1 pin)', () => {
  it('상수 값이 실 seed의 role 키와 정확히 일치한다("크리에이터" 표시라벨이 아니다)', () => {
    expect(MARKETING_CREATOR_ROLE_KEY).toBe('Creator');
    expect(Object.keys(groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA))).toContain(MARKETING_CREATOR_ROLE_KEY);
  });
});

describe('expandRoleSlotBindings — bindableRoles 화이트리스트 밖 role은 강제로 걸러진다', () => {
  it('MARKETING_CREATOR_ROLE_KEY 선택만 그 role의 4 stage를 채운다(유일한 role_mapping-eligible 축) — #4426 핵심 회귀', () => {
    const roleMapping = expandRoleSlotBindings(
      MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, BINDABLE_ROLES, { [MARKETING_CREATOR_ROLE_KEY]: 'member-creator' },
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
      Director: 'member-director', [MARKETING_CREATOR_ROLE_KEY]: 'member-creator', Publisher: 'member-publisher',
    });
    expect(Object.keys(roleMapping).sort()).toEqual(['animatic', 'draft', 'editing', 'verification']);
    expect(roleMapping.concept_confirmed).toBeUndefined();
    expect(roleMapping.pending_approval).toBeUndefined();
  });

  it('bindableRoles를 넓히면(호출부가 명시적으로 그렇게 하지 않는 한) 그 role도 펼쳐진다 — 화이트리스트가 유일한 관문', () => {
    const roleMapping = expandRoleSlotBindings(
      MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, [MARKETING_CREATOR_ROLE_KEY, 'Director'], {
        [MARKETING_CREATOR_ROLE_KEY]: 'member-creator', Director: 'member-director',
      },
    );
    expect(roleMapping.concept_confirmed).toBe('member-director');
    expect(roleMapping.draft).toBe('member-creator');
  });

  it('빈 문자열 선택·존재하지 않는 role 키는 무시된다(연산 슬롯을 selections에 줘도 안전)', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, BINDABLE_ROLES, {
      [MARKETING_CREATOR_ROLE_KEY]: '', Compute: 'member-compute',
    });
    expect(roleMapping).toEqual({});
  });
});

describe('stagesWithCapability — role과 독립인 인프라/커넥터 축', () => {
  it('capability를 선언한 stage 2곳(live_generation·published)만 뽑는다', () => {
    const stages = stagesWithCapability(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(stages).toEqual([
      { stage: 'live_generation', role: 'Compute', capability: { kind: 'generate' } },
      { stage: 'published', role: 'Publisher', capability: { kind: 'publish' } },
    ]);
  });
});

describe('stagesWithGate — Director(사람) 게이트 승인 주체 축(role_mapping과 분리, PO 判定 2026-09-18)', () => {
  it('gate를 선언한 stage 2곳(concept_confirmed·pending_approval)만 뽑고 approver를 그대로 노출한다', () => {
    const stages = stagesWithGate(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(stages).toEqual([
      { stage: 'concept_confirmed', role: 'Director', gate: { type: 'concept_approval', approver: 'org_owner' } },
      { stage: 'pending_approval', role: 'Director', gate: { type: 'external_publish', approver: 'org_owner' } },
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
