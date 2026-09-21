// @vitest-environment jsdom
//
// story #4101 — 적용 다이얼로그 연산(Compute) 슬롯 픽커. capability.target=
// "generation_connector"인 stage는 agent/channel_connection과 별도로 org의 active
// 생성 커넥터 목록에서 고른다(있음/없음 2상태 pin — #4090 채널 피커와 동형 축).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RecipeRoleMappingFields } from './recipe-role-mapping-fields';

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
      root.render(
        <RecipeRoleMappingFields
          stages={['compute']}
          stageMetadata={STAGE_METADATA}
          agents={[]}
          channelConnections={[]}
          generationConnectors={[
            { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인 연산 커넥터', status: 'active' },
            { id: 'gc-2', provider_key: 'vertex_gemini', label: 'revoke됨', status: 'revoked' },
          ]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />,
      );
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
      root.render(
        <RecipeRoleMappingFields
          stages={['compute']}
          stageMetadata={STAGE_METADATA}
          agents={[]}
          channelConnections={[]}
          generationConnectors={[]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />,
      );
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
      root.render(
        <RecipeRoleMappingFields
          stages={['agent_stage']}
          stageMetadata={{ agent_stage: { role: 'Creator' } }}
          agents={[{ id: 'a-1', name: '에이전트A' }]}
          channelConnections={[]}
          generationConnectors={[{ id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', status: 'active' }]}
          roleMapping={{}}
          onChange={onChange}
          agentPlaceholder="에이전트 선택..."
          channelPlaceholder="채널 선택..."
          generationConnectorPlaceholder="연산 커넥터 선택..."
        />,
      );
    });

    const select = container.querySelector('select');
    const optionTexts = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionTexts).toContain('에이전트A');
    expect(optionTexts).not.toContain('메인');
  });
});
