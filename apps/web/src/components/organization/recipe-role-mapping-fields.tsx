'use client';

import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';

interface AgentOption {
  id: string;
  name: string;
}

// story #3316 — workflow-template-gallery-section.tsx(구, 프로젝트 설정 화면)의 인라인
// role→agent <select> 루프를 추출한 공용 컴포넌트. organization/events 카탈로그의 신규
// "프로젝트에 적용" 다이얼로그와 gallery 둘 다 이걸 쓴다 — role_mapping 입력 UI가 두 곳에서
// 갈라지면(예: 한쪽만 stage 라벨을 바꾸는 식) role_mapping payload shape는 같은데 사람이 채우는
// 경험만 달라지는 조용한 드리프트가 생긴다.
export function RecipeRoleMappingFields({
  stages,
  stageMetadata,
  agents,
  roleMapping,
  onChange,
  agentPlaceholder,
}: {
  stages: string[];
  stageMetadata: EventDefinitionResponse['stage_metadata'];
  agents: AgentOption[];
  roleMapping: Record<string, string>;
  onChange: (stage: string, agentId: string) => void;
  agentPlaceholder: string;
}) {
  return (
    <>
      {stages.map((stage) => {
        const meta = stageMetadata[stage];
        return (
          <div key={stage} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-xs font-medium text-foreground">
              {meta?.role ?? stage}
            </span>
            <select
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={roleMapping[stage] ?? ''}
              onChange={(e) => onChange(stage, e.target.value)}
            >
              <option value="">{agentPlaceholder}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        );
      })}
    </>
  );
}
