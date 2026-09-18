import { describe, expect, it } from 'vitest';
import {
  expandRoleSlotBindings, groupStagesByRole, recipeKeyDomain, stagesWithCapability,
  type RecipeStageMetadata,
} from './recipe-role-slots';

// #4039(PR #4419, backend/alembic/versions/0379_preset_marketing_video_production_recipe.py)
// _STAGE_METADATA를 그대로 옮긴 고정물 — 이 카드(#4046) 작성 시점 그 PR이 아직 안 착지해
// (base=develop OPEN) dev에서 직접 실증은 못 하지만(AC4 "seed shape 위에서 배선"), 그 마이그의
// 실제 값을 문자 그대로 베껴 이 순수 함수들이 착지 후 그 데이터를 정확히 다룬다는 걸 지금
// 고정한다 — 착지 후에는 이 fixture를 실 API 응답으로 교체해 회귀 여부를 바로 알 수 있다.
const MARKETING_VIDEO_PRODUCTION_STAGE_METADATA: RecipeStageMetadata = {
  draft: { role: '크리에이터', action: '로그라인·매핑표·컨셉 초안 작성' },
  concept_confirmed: {
    role: '디렉터', action: '우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인',
    gate: { type: 'concept_approval', approver: 'org_owner' },
  },
  animatic: { role: '크리에이터', action: '무과금 스틸+텍스트+VO 애니매틱 제작' },
  structure_passed: { role: '디렉터', action: '무과금 애니매틱으로 구조 판정 승인' },
  live_generation: {
    role: '디렉터', action: '표적·예산을 명시해 실탄(유료 생성) 발사 승인',
    capability: { kind: 'generate' },
  },
  verification: { role: '크리에이터', action: '프레임8+받아쓰기 등 눈·귀 검증 시트 작성' },
  editing: { role: '크리에이터', action: '편집 통일 패스(그레이드·룸톤·자막 레벨 통일)' },
  pending_approval: {
    role: '발행자', action: '최종 발행 승인 대기(외부 발행 직전)',
    gate: { type: 'external_publish', approver: 'org_owner' },
  },
  published: { role: '발행자', action: '승인된 채널에 실 게시', capability: { kind: 'publish' } },
};

describe('groupStagesByRole — #4039 마케팅 레시피 1호 stage_metadata 실측 기준', () => {
  it('9 stage가 role 라벨 3종(디렉터·크리에이터·발행자)으로 정확히 갈린다', () => {
    const groups = groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(Object.keys(groups).sort()).toEqual(['디렉터', '발행자', '크리에이터']);
    expect(groups['디렉터']).toEqual(['concept_confirmed', 'structure_passed', 'live_generation']);
    expect(groups['크리에이터']).toEqual(['draft', 'animatic', 'verification', 'editing']);
    expect(groups['발행자']).toEqual(['pending_approval', 'published']);
  });

  it('role 없는 stage는 그룹에서 빠진다(신호형/측정형 정의의 빈 stage_metadata 등)', () => {
    const groups = groupStagesByRole({ x: { action: 'no role' }, y: {} });
    expect(groups).toEqual({});
  });

  it('"연산" 같은 role 값은 이 fixture에 없다 — capability로만 선언되는 축이라 groupStagesByRole 밖', () => {
    const groups = groupStagesByRole(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(groups['연산']).toBeUndefined();
  });
});

describe('expandRoleSlotBindings — role 슬롯 선택 → 전체 stage role_mapping 펼침', () => {
  it('디렉터·크리에이터·발행자 3명 선택이 9 stage 전부를 채운다', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, {
      '디렉터': 'member-director', '크리에이터': 'member-creator', '발행자': 'member-publisher',
    });
    expect(Object.keys(roleMapping).sort()).toEqual([
      'animatic', 'concept_confirmed', 'draft', 'editing', 'live_generation',
      'pending_approval', 'published', 'structure_passed', 'verification',
    ]);
    expect(roleMapping.concept_confirmed).toBe('member-director');
    expect(roleMapping.structure_passed).toBe('member-director');
    expect(roleMapping.live_generation).toBe('member-director');
    expect(roleMapping.draft).toBe('member-creator');
    expect(roleMapping.pending_approval).toBe('member-publisher');
  });

  it('일부 role만 선택하면 그 stage들만 채워진다(부분 apply — 백엔드가 subset을 허용)', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, {
      '디렉터': 'member-director',
    });
    expect(Object.keys(roleMapping).sort()).toEqual(['concept_confirmed', 'live_generation', 'structure_passed']);
  });

  it('빈 문자열 선택·존재하지 않는 role 라벨은 무시된다(연산 슬롯을 selections에 줘도 안전)', () => {
    const roleMapping = expandRoleSlotBindings(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, {
      '디렉터': '', '연산': 'member-compute',
    });
    expect(roleMapping).toEqual({});
  });
});

describe('stagesWithCapability — role과 독립인 인프라/커넥터 축', () => {
  it('capability를 선언한 stage 2곳(live_generation·published)만 뽑는다', () => {
    const stages = stagesWithCapability(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA);
    expect(stages).toEqual([
      { stage: 'live_generation', role: '디렉터', capability: { kind: 'generate' } },
      { stage: 'published', role: '발행자', capability: { kind: 'publish' } },
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
