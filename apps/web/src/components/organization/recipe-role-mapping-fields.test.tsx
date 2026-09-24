// @vitest-environment jsdom
//
// story #4101 — 적용 다이얼로그 연산(Compute) 슬롯 픽커. capability.target=
// "generation_connector"인 stage는 agent/channel_connection과 별도로 org의 active
// 생성 커넥터 목록에서 고른다(있음/없음 2상태 pin — #4090 채널 피커와 동형 축).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { RecipeRoleMappingFields } from './recipe-role-mapping-fields';
import koMessages from '../../../messages/ko.json';

const withIntl = (node: React.ReactNode) => <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const STAGE_METADATA = {
  compute: {
    role: 'Compute', action: '생성한다',
    capability: { kind: 'generate', target: 'generation_connector' as const },
  },
};

async function render() {
  const onChange = () => {};
  return { onChange };
}

describe('RecipeRoleMappingFields — generation_connector 슬롯(story #4101)', () => {
  it('있음 — active 연산 커넥터 옵션이 select에 라벨로 렌더된다', async () => {
    const { onChange } = await render();
    await act(async () => {
      root.render(withIntl(
        <RecipeRoleMappingFields
          stages={['compute']}
          stageMetadata={STAGE_METADATA}
          members={[]}
          channelConnections={[]}
          generationConnectors={[
            { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인 연산 커넥터', status: 'active' },
            { id: 'gc-2', provider_key: 'vertex_gemini', label: 'revoke됨', status: 'revoked' },
          ]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          personPlaceholder="사람 선택..."
          memberPlaceholder="담당 선택..."
          approvalNote={(s) => `approval:${s}`}
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />
      ));
    });

    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    const optionTexts = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('메인 연산 커넥터');
    // revoked는 active 필터에 걸려 옵션에 없다.
    expect(optionTexts).not.toContain('revoke됨');
  });

  it('없음 — 옵션 0건이면 placeholder만 있는 select가 그려진다(크래시 0)', async () => {
    const { onChange } = await render();
    await act(async () => {
      root.render(withIntl(
        <RecipeRoleMappingFields
          stages={['compute']}
          stageMetadata={STAGE_METADATA}
          members={[]}
          channelConnections={[]}
          generationConnectors={[]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          personPlaceholder="사람 선택..."
          memberPlaceholder="담당 선택..."
          approvalNote={(s) => `approval:${s}`}
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />
      ));
    });

    const select = container.querySelector('select');
    expect(select).toBeTruthy();
    const options = select!.querySelectorAll('option');
    expect(options.length).toBe(1);
    expect(options[0].textContent).toBe('연산 커넥터 선택...');
  });

  it('agent/channel_connection 대상 stage는 무변 — target=generation_connector일 때만 이 축을 탄다', async () => {
    const { onChange } = await render();
    await act(async () => {
      root.render(withIntl(
        <RecipeRoleMappingFields
          stages={['agent_stage']}
          stageMetadata={{ agent_stage: { role: 'Creator' } }}
          members={[{ id: 'a-1', name: '에이전트A' }]}
          channelConnections={[]}
          generationConnectors={[{ id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', status: 'active' }]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          personPlaceholder="사람 선택..."
          memberPlaceholder="담당 선택..."
          approvalNote={(s) => `approval:${s}`}
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />
      ));
    });

    const select = container.querySelector('select');
    const optionTexts = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('에이전트A');
    expect(optionTexts).not.toContain('메인');
  });
});

// story #4243 — 멤버 stage의 선택지는 정의의 role_actor_kinds로 거른다(human → 사람 · agent/선언 없음 → 에이전트 · either → 함께).
describe('RecipeRoleMappingFields — 멤버 종류(story #4243)', () => {
  const MEMBERS = [
    { id: 'a-1', name: '에이전트A', type: 'agent' },
    { id: 'h-1', name: '사람B', type: 'human' },
  ];
  const META = {
    goal: { role: 'Human' },
    brief: { role: 'PO' },
    variants: { role: 'Agent' },
    legacy: { role: 'Undeclared' },
  };

  async function renderKinds() {
    await act(async () => {
      root.render(withIntl(
        <RecipeRoleMappingFields
          stages={['goal', 'brief', 'variants', 'legacy']}
          stageMetadata={META}
          members={MEMBERS}
          roleActorKinds={{ Human: 'human', PO: 'either', Agent: 'agent' }}
          channelConnections={[]}
          generationConnectors={[]}
          roleMapping={{}}
          onChange={() => {}}
          agentPlaceholder="에이전트 선택..."
          personPlaceholder="사람 선택..."
          memberPlaceholder="담당 선택..."
          approvalNote={(s) => `approval:${s}`}
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />
      ));
    });
    return Array.from(container.querySelectorAll('select')).map((s) => Array.from(s.querySelectorAll('option')).map((o) => o.textContent));
  }

  it('human → 사람만 · either → 사람 + 에이전트 · agent → 에이전트만 · 선언 없음 → 에이전트만(예전 그대로)', async () => {
    const [goal, brief, variants, legacy] = await renderKinds();
    expect(goal).toEqual(['사람 선택...', '사람B']);
    expect(brief).toEqual(['담당 선택...', '에이전트A', '사람B']);
    expect(variants).toEqual(['에이전트 선택...', '에이전트A']);
    expect(legacy).toEqual(['에이전트 선택...', '에이전트A']);
  });
});

// 유나 design(4606) — 행 이름은 단계 라벨 · 승인 자리 선언이 있는데 에이전트 선택기로 그려지는 행은 선택기 아래 흐린 한 줄.
describe('RecipeRoleMappingFields — 행 이름 · 승인 자리 안내(story #4243 · 유나 design)', () => {
  it('행 이름 = 단계 라벨(역할 원문 아님) · 에이전트 역할의 브리프 행은 선택기 + «결재함에서 문서 결재» 줄', async () => {
    await act(async () => {
      root.render(withIntl(
        <RecipeRoleMappingFields
          stages={['goal_hypothesis', 'brief_doc_approval', 'custom_stage', 'my_step_2']}
          stageMetadata={{
            goal_hypothesis: { role: 'Human' },
            brief_doc_approval: { role: 'PO', approval: { surface: 'doc_approval' } },
            custom_stage: { role: '검토 담당자' },
            my_step_2: {},
          }}
          members={[{ id: 'a-1', name: '에이전트A', type: 'agent' }]}
          roleActorKinds={{ Human: 'agent', PO: 'agent', Worker: 'agent' }}
          channelConnections={[]}
          generationConnectors={[]}
          roleMapping={{}}
          onChange={() => {}}
          agentPlaceholder="에이전트 선택…"
          personPlaceholder="사람 선택…"
          memberPlaceholder="담당자 선택…"
          approvalNote={(surface) => `note:${surface}`}
          channelPlaceholder="채널 선택…"
          generationConnectorPlaceholder="연산 커넥터 선택…"
        />,
      ));
    });
    const label = (stage: string) => container.querySelector(`[data-testid="mapping-row-label-${stage}"]`)?.textContent;
    expect(label('goal_hypothesis')).toBe(koMessages.organization.recipeStageLabelGoalHypothesis);
    expect(label('brief_doc_approval')).toBe(koMessages.organization.recipeStageLabelBriefDocApproval);
    // 까디르 QA — 라벨 표에 없는 조직 정의 stage는 role(있으면), 없으면 slug.
    expect(label('custom_stage')).toBe('검토 담당자');
    expect(label('my_step_2')).toBe('my_step_2');
    expect(container.textContent).not.toContain('Human');
    expect(container.querySelectorAll('select')).toHaveLength(4); // 에이전트 역할이라 브리프도 선택기
    expect([...container.querySelectorAll('[data-testid="mapping-approval-note"]')].map((n) => n.textContent)).toEqual(['note:doc_approval']);
  });
});
