'use client';

import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { membersForKind, stageApprovalSurface, stageMemberKind, type RoleActorKinds } from '@/lib/recipe-role-slots';

// story #4243 — 멤버 선택지는 사람 + 에이전트(`type`). stage마다 정의의 role_actor_kinds로 거른다(human → 사람 ·
// agent/선언 없음 → 에이전트 · either → 함께).
export interface MemberOption {
  id: string;
  name: string;
  type?: string;
}

// story #4090(alembic 0385) — GET .../channel-connections 응답의 부분집합(select 렌더에
// 필요한 필드만, organization/channels 화면과 같은 BFF 재사용 — 신규 엔드포인트 0).
export interface ChannelConnectionOption {
  id: string;
  channel: string;
  account_label: string | null;
  account_id: string;
  status: string;
}

// story #4101 — GET .../generation-connectors 응답의 부분집합(select 렌더에 필요한
// 필드만 — credentials는 그 응답 자체에 없다, write-only 계약).
export interface GenerationConnectorOption {
  id: string;
  provider_key: string;
  label: string;
  status: string;
}

// story #3316 — workflow-template-gallery-section.tsx(구, 프로젝트 설정 화면)의 인라인
// role→agent <select> 루프를 추출한 공용 컴포넌트. organization/events 카탈로그의 신규
// "프로젝트에 적용" 다이얼로그와 gallery 둘 다 이걸 쓴다 — role_mapping 입력 UI가 두 곳에서
// 갈라지면(예: 한쪽만 stage 라벨을 바꾸는 식) role_mapping payload shape는 같은데 사람이 채우는
// 경험만 달라지는 조용한 드리프트가 생긴다.
//
// story #4090(alembic 0385, 페드루 PO 確定 2026-09-21) — capability.target=
// "channel_connection"인 stage(Publisher)는 알릴 사람이 아니라 발행할 채널을 고른다 —
// role_mapping 값의 shape는 그대로(uuid 문자열 하나, stage→id)라 onChange/payload 계약은
// 무변, select 옵션 소스만 stage별로 agents/channelConnections 중 하나로 갈린다.
export function RecipeRoleMappingFields({
  stages,
  stageMetadata,
  members,
  roleActorKinds,
  channelConnections,
  generationConnectors,
  roleMapping,
  onChange,
  agentPlaceholder,
  personPlaceholder,
  memberPlaceholder,
  channelPlaceholder,
  generationConnectorPlaceholder,
  approvalNote,
}: {
  stages: string[];
  stageMetadata: EventDefinitionResponse['stage_metadata'];
  members: MemberOption[];
  roleActorKinds?: RoleActorKinds | null;
  channelConnections: ChannelConnectionOption[];
  generationConnectors: GenerationConnectorOption[];
  roleMapping: Record<string, string>;
  onChange: (stage: string, value: string) => void;
  agentPlaceholder: string;
  personPlaceholder: string;
  memberPlaceholder: string;
  channelPlaceholder: string;
  generationConnectorPlaceholder: string;
  /** story #4243 D3 — 승인이 stage 밖(approval.surface)인 stage의 읽기 전용 안내 문구. */
  approvalNote: (surface: string) => string;
}) {
  // sandbox 포함 — status로 걸러 disconnected 등은 아예 안 보인다(잘못 고를 표면 자체를
  // 없앤다, "고른 뒤 실패"보다 "애초에 못 고름"이 싸다).
  const activeChannelConnections = channelConnections.filter((c) => c.status === 'active');
  // story #4101 — 같은 원칙, revoked 커넥터는 애초에 선택지에 안 나온다.
  const activeGenerationConnectors = generationConnectors.filter((c) => c.status === 'active');

  return (
    <>
      {stages.map((stage) => {
        const meta = stageMetadata[stage];
        const target = meta?.capability?.target;
        const memberKind = stageMemberKind(stage, stageMetadata, roleActorKinds) ?? 'agent';
        const approvalSurface = stageApprovalSurface(stage, stageMetadata, roleActorKinds);
        return (
          <div key={stage} className="flex items-center gap-3">
            <span className="w-32 shrink-0 text-xs font-medium text-foreground">
              {meta?.role ?? stage}
            </span>
            {approvalSurface ? (
              // story #4243 D3 — 승인이 이 stage 밖(결재함)이라 고를 담당이 없다. 선택기 없음 · 필수 아님 · role_mapping에 안 실림.
              <span className="flex-1 break-keep text-xs text-muted-foreground" data-testid="mapping-approval-elsewhere">
                {approvalNote(approvalSurface)}
              </span>
            ) : target === 'channel_connection' ? (
              <select
                className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={roleMapping[stage] ?? ''}
                onChange={(e) => onChange(stage, e.target.value)}
              >
                <option value="">{channelPlaceholder}</option>
                {activeChannelConnections.map((c) => (
                  <option key={c.id} value={c.id}>{c.account_label || `${c.channel}(${c.account_id})`}</option>
                ))}
              </select>
            ) : target === 'generation_connector' ? (
              <select
                className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={roleMapping[stage] ?? ''}
                onChange={(e) => onChange(stage, e.target.value)}
              >
                <option value="">{generationConnectorPlaceholder}</option>
                {activeGenerationConnectors.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            ) : (
              <select
                className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={roleMapping[stage] ?? ''}
                onChange={(e) => onChange(stage, e.target.value)}
              >
                <option value="">
                  {memberKind === 'human' ? personPlaceholder : memberKind === 'either' ? memberPlaceholder : agentPlaceholder}
                </option>
                {membersForKind(members, memberKind).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </>
  );
}
