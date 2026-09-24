import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  allowedChannelsForSlot, groupStagesByRole, membersForKind, orderedRecipeRoles, requiredMappingStages, stageMemberKind, recipeConnectionTargets, recipeKeyDomain,
  recipeRoleSlots, roleActorKind, stagesInFlowOrder, stagesWithCapability, stagesWithGate, uncoveredRecipeStages,
  type RecipeRoleSlot, type RecipeStageMetadata,
} from './recipe-role-slots';
import { VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE } from './video-production-seed.test.fixture';
import { BLOG_ARTICLE_FLOW, BLOG_ARTICLE_RECIPE } from './blog-article-seed.test.fixture';

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
    expect(slots).toEqual([{ key: 'Writer:member', role: 'Writer', kind: 'member', stages: ['draft'], memberType: 'human', gateApprovers: [] }]);
  });

  // 까디르 QA(PR #4547) 재현 A — 한 역할이 일반 단계와 채널 단계를 같이 가지면 예전엔 채널 자리
  // 하나만 생기고 draft가 표시 없이 바인딩에서 빠졌다. 이제 방식마다 자리가 하나씩.
  it('A: 일반 단계+채널 단계를 가진 역할 = 멤버 자리(draft) + 채널 자리(published)', () => {
    const slots = recipeRoleSlots({
      draft: { role: 'Writer' },
      published: { role: 'Writer', capability: { kind: 'publish', target: 'channel_connection' } },
    }, ['draft', 'published'], { Writer: 'agent' });
    expect(slots.map((s) => [s.key, s.kind, s.stages])).toEqual([
      ['Writer:member', 'member', ['draft']],
      ['Writer:channel', 'channel', ['published']],
    ]);
  });

  // 재현 B — 선언이 일부 역할에만 있으면 선언 없는 게이트 전용 역할이 에이전트 멤버 자리가 됐다
  // (선언이 아예 없으면 승인자). 선언 없는 역할은 다른 역할의 선언 여부와 상관없이 같은 규칙.
  it('B: 선언 없는 게이트 전용 역할은 다른 역할 선언 유무와 상관없이 승인 자리', () => {
    const meta: RecipeStageMetadata = {
      draft: { role: 'Writer' },
      review: { role: 'Editor', gate: { type: 'doc_approval', approver: 'org_owner' } },
    };
    const none = recipeRoleSlots(meta, ['draft', 'review'], null);
    const partial = recipeRoleSlots(meta, ['draft', 'review'], { Writer: 'agent' });
    expect(none.find((s) => s.role === 'Editor')).toMatchObject({ kind: 'approver', stages: ['review'] });
    expect(partial.find((s) => s.role === 'Editor')).toMatchObject({ kind: 'approver', stages: ['review'] });
  });

  // 재현 C — 사람 역할이 일반 작업과 게이트를 같이 가지면 승인 자리만 생겨 작업 단계를 배정할
  // 길이 없었다. 이제 사람 멤버 자리(작업) + 승인 자리(게이트), 자리 순서는 첫 단계 흐름 순서.
  it('C: 일반 작업+게이트를 가진 사람 역할 = 사람 멤버 자리(작업) + 승인 자리(게이트)', () => {
    const slots = recipeRoleSlots({
      brief: { role: 'Lead' },
      draft: { role: 'Writer' },
      signoff: { role: 'Lead', gate: { type: 'doc_approval', approver: 'org_owner' } },
    }, ['brief', 'draft', 'signoff'], { Lead: 'human', Writer: 'agent' });
    expect(slots.map((s) => [s.key, s.kind, s.stages, s.memberType])).toEqual([
      ['Lead:member', 'member', ['brief'], 'human'],
      ['Lead:approver', 'approver', ['signoff'], 'human'],
      ['Writer:member', 'member', ['draft'], 'agent'],
    ]);
  });

  // 까디르 재QA(PR #4547 25a02567d) — 사람 역할의 «게이트 달린 채널 단계». 승인 판정이 채널보다
  // 먼저면 읽기 전용 승인 자리로 가서 채널 바인딩이 조용히 빠진다.
  it('사람 역할 + 게이트 + channel_connection 단계 → 채널 자리(승인 자리 아님)', () => {
    const slots = recipeRoleSlots({
      review: { role: 'Lead', gate: { type: 'doc_approval', approver: 'org_owner' } },
      published: { role: 'Lead', gate: { type: 'external_publish', approver: 'org_owner' }, capability: { kind: 'publish', target: 'channel_connection' } },
    }, ['review', 'published'], { Lead: 'human' });
    expect(slots.map((s) => [s.key, s.stages])).toEqual([
      ['Lead:approver', ['review']],
      ['Lead:channel', ['published']],
    ]);
  });

  it('에이전트 역할의 게이트 stage는 그 에이전트 멤버 자리에 남는다(그 stage를 발행하는 쪽)', () => {
    const slots = recipeRoleSlots(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE.role_actor_kinds);
    expect(slots.find((s) => s.role === 'Creator')!.stages).toContain('animatic');
    expect(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA.animatic!.gate).toBeTruthy();
  });
});

describe('uncoveredRecipeStages — 불변식: role이 있는 모든 stage가 정확히 한 자리에', () => {
  const SHAPES: [string, RecipeStageMetadata, string[], Parameters<typeof recipeRoleSlots>[2]][] = [
    ['영상 레시피(선언)', MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, [...VIDEO_PRODUCTION_FLOW], VIDEO_PRODUCTION_RECIPE.role_actor_kinds],
    ['영상 레시피(선언 없음)', MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, [...VIDEO_PRODUCTION_FLOW], null],
    ['A', { draft: { role: 'Writer' }, published: { role: 'Writer', capability: { target: 'channel_connection' } } }, ['draft', 'published'], { Writer: 'agent' }],
    ['B', { draft: { role: 'Writer' }, review: { role: 'Editor', gate: { type: 'g', approver: 'org_owner' } } }, ['draft', 'review'], { Writer: 'agent' }],
    ['C', { brief: { role: 'Lead' }, signoff: { role: 'Lead', gate: { type: 'g', approver: 'org_owner' } } }, ['brief', 'signoff'], { Lead: 'human' }],
    ['사람 역할 게이트 달린 채널 단계', {
      review: { role: 'Lead', gate: { type: 'g', approver: 'org_owner' } },
      published: { role: 'Lead', gate: { type: 'g', approver: 'org_owner' }, capability: { target: 'channel_connection' } },
    }, ['review', 'published'], { Lead: 'human' }],
    ['한 역할 네 방식', {
      a: { role: 'X' }, b: { role: 'X', gate: { type: 'g', approver: 'org_owner' } },
      c: { role: 'X', capability: { target: 'generation_connector' } }, d: { role: 'X', capability: { target: 'channel_connection' } },
    }, ['a', 'b', 'c', 'd'], { X: 'human' }],
  ];

  it.each(SHAPES)('%s — 덮이지 않은 stage 0', (_name, meta, flow, kinds) => {
    expect(uncoveredRecipeStages(meta, flow, recipeRoleSlots(meta, flow, kinds))).toEqual([]);
  });

  it('자리에서 stage 하나를 빼면 그 stage가 잡힌다', () => {
    const slots = recipeRoleSlots(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE.role_actor_kinds);
    const dropped: RecipeRoleSlot[] = slots.map((s) => (s.role === 'Creator' ? { ...s, stages: s.stages.filter((x) => x !== 'draft') } : s));
    expect(uncoveredRecipeStages(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, dropped)).toEqual(['draft']);
  });

  it('두 자리에 겹쳐 덮인 stage도 잡힌다', () => {
    const slots = recipeRoleSlots(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, VIDEO_PRODUCTION_RECIPE.role_actor_kinds);
    const doubled: RecipeRoleSlot[] = [...slots, { ...slots[0]!, key: 'dup', stages: ['published'] }];
    expect(uncoveredRecipeStages(MARKETING_VIDEO_PRODUCTION_STAGE_METADATA, VIDEO_PRODUCTION_FLOW, doubled)).toEqual(['published']);
  });

  it('연결 target 단계가 맞지 않는 방식의 자리(승인)에 들어가면 덮이지 않은 것과 똑같이 잡힌다', () => {
    const meta: RecipeStageMetadata = {
      published: { role: 'Lead', gate: { type: 'g', approver: 'org_owner' }, capability: { target: 'channel_connection' } },
      gen: { role: 'Lead', capability: { target: 'generation_connector' } },
    };
    const wrong: RecipeRoleSlot[] = [
      { key: 'Lead:approver', role: 'Lead', kind: 'approver', stages: ['published'], memberType: 'human', gateApprovers: ['org_owner'] },
      { key: 'Lead:member', role: 'Lead', kind: 'member', stages: ['gen'], memberType: 'human', gateApprovers: [] },
    ];
    expect(uncoveredRecipeStages(meta, ['published', 'gen'], wrong)).toEqual(['published', 'gen']);
  });

  it('role 없는 stage는 불변식 대상이 아니다', () => {
    expect(uncoveredRecipeStages({ x: { action: 'no role' } }, ['x'], [])).toEqual([]);
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

// story #4174 후속 — 승인이 stage 밖(초안 게이트)이라고 정의가 선언한 사람 stage는 읽기 전용 자리. 선언 없는 사람 비게이트
// stage(위 142줄 · 재현 C)는 그대로 멤버 자리 — 둘을 가르는 것은 정의의 선언뿐(stage 이름 상수 없음).
describe('approval.surface — 승인이 stage 밖인 사람 stage(story #4174 후속)', () => {
  it('블로그 레시피(실 seed): 디렉터 = 승인 자리(컨셉) + 읽기 전용 자리(승인 대기) · 크리에이터 · 발행자', () => {
    const slots = recipeRoleSlots(BLOG_ARTICLE_RECIPE.stage_metadata, BLOG_ARTICLE_FLOW, BLOG_ARTICLE_RECIPE.role_actor_kinds);
    expect(slots.map((s) => [s.key, s.kind, s.stages, s.memberType])).toEqual([
      ['Director:approver', 'approver', ['concept_confirmed'], 'human'],
      ['Director:approval_elsewhere', 'approval_elsewhere', ['pending_approval'], 'human'],
      ['Creator:member', 'member', ['planning', 'writing', 'verification'], 'agent'],
      ['Publisher:member', 'member', ['published', 'publish_checked'], 'agent'],
    ]);
    expect(uncoveredRecipeStages(BLOG_ARTICLE_RECIPE.stage_metadata, BLOG_ARTICLE_FLOW, slots)).toEqual([]);
  });

  it('선언이 없으면 같은 모양의 사람 stage는 지금처럼 멤버 자리(142줄 규칙 유지)', () => {
    const slots = recipeRoleSlots({ wait: { role: 'Lead' } }, ['wait'], { Lead: 'human' });
    expect(slots.map((s) => [s.kind, s.memberType])).toEqual([['member', 'human']]);
  });

  it('에이전트 역할의 선언은 읽기 전용이 되지 않는다(사람 역할에만 해당)', () => {
    const slots = recipeRoleSlots({ wait: { role: 'Writer', approval: { surface: 'draft_gate' } } }, ['wait'], { Writer: 'agent' });
    expect(slots.map((s) => s.kind)).toEqual(['member']);
  });

  it('선언이 없는 정의(role_actor_kinds 없음)에서도 게이트·승인 선언만 가진 역할은 사람으로 본다', () => {
    const slots = recipeRoleSlots({
      review: { role: 'Editor', gate: { type: 'doc_approval', approver: 'org_owner' } },
      wait: { role: 'Editor', approval: { surface: 'draft_gate' } },
    }, ['review', 'wait'], null);
    expect(slots.map((s) => [s.kind, s.stages])).toEqual([['approver', ['review']], ['approval_elsewhere', ['wait']]]);
  });
});

// story #4239 — 채널 자리의 허용 채널 종류 = 그 자리 stage들이 선언한 capability.channels의 교집합(선언 없으면 null=제한 없음).
describe('allowedChannelsForSlot(story #4239)', () => {
  const slot = (stages: string[]): RecipeRoleSlot => ({ key: 'P:channel', role: 'P', kind: 'channel', stages, memberType: 'agent', gateApprovers: [] });
  const pub = (channels?: string[]) => ({ role: 'P', capability: { kind: 'publish', target: 'channel_connection', ...(channels ? { channels } : {}) } });

  it('선언이 없으면 null(예전대로 제한 없음)', () => {
    expect(allowedChannelsForSlot(slot(['published']), { published: pub() })).toBeNull();
  });

  it('선언이 하나면 그 목록', () => {
    expect(allowedChannelsForSlot(slot(['campaign_created']), { campaign_created: pub(['stibee', 'stibee_sandbox']) })).toEqual(['stibee', 'stibee_sandbox']);
  });

  it('여러 stage가 선언하면 교집합 · 선언 없는 stage는 제한을 안 더한다', () => {
    expect(allowedChannelsForSlot(slot(['a', 'b', 'c']), {
      a: pub(['threads', 'x', 'facebook']), b: pub(['x', 'facebook', 'instagram']), c: pub(),
    })).toEqual(['x', 'facebook']);
  });
});

// story #4243 — role_actor_kinds 세 번째 값 `either`.
describe('either(story #4243)', () => {
  const META = {
    goal: { role: 'Human', action: '목표' },
    brief: { role: 'PO', action: '브리프' },
    review: { role: 'PO', action: '검토', gate: { type: 'x', approver: 'org_owner' } },
    variants: { role: 'Agent', action: '실행안' },
    run: { role: 'Any', action: '실행' },
  };
  const FLOW = ['goal', 'brief', 'review', 'variants', 'run'];
  const KINDS = { Human: 'human', PO: 'either', Agent: 'agent', Any: 'either' } as const;

  it('either 역할은 사람 + 에이전트 멤버 자리 — 게이트 stage도 승인 자리가 아니라 같은 멤버 자리(게이트 승인자는 게이트 규칙)', () => {
    const slots = recipeRoleSlots(META, FLOW, KINDS);
    const po = slots.filter((s) => s.role === 'PO');
    expect(po).toEqual([{ key: 'PO:member', role: 'PO', kind: 'member', stages: ['brief', 'review'], memberType: 'either', gateApprovers: [] }]);
    expect(slots.find((s) => s.role === 'Any')?.memberType).toBe('either');
    expect(slots.find((s) => s.role === 'Human')?.memberType).toBe('human');
    expect(slots.find((s) => s.role === 'Agent')?.memberType).toBe('agent');
    expect(uncoveredRecipeStages(META, FLOW, slots)).toEqual([]);
  });

  it('범용 창: 멤버 종류 · 필수 stage(사람 stage만 선택) · 선택지', () => {
    expect(FLOW.map((s) => stageMemberKind(s, META, KINDS))).toEqual(['human', 'either', 'either', 'agent', 'either']);
    expect(stageMemberKind('run', META, null)).toBe('agent'); // 선언 없음 → 예전 그대로 에이전트
    expect(requiredMappingStages(FLOW, META, KINDS)).toEqual(['brief', 'review', 'variants', 'run']);
    const members = [{ id: 'a', type: 'agent' }, { id: 'h', type: 'human' }, { id: 'x' }];
    expect(membersForKind(members, 'either').map((m) => m.id)).toEqual(['a', 'h', 'x']);
    expect(membersForKind(members, 'human').map((m) => m.id)).toEqual(['h']);
    expect(membersForKind(members, 'agent').map((m) => m.id)).toEqual(['a', 'x']);
  });
});
