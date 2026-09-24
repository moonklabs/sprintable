'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { RECIPE_CONNECTION_TARGETS, allowedChannelsForSlot, recipeRoleSlots, uncoveredRecipeStages, type RecipeRoleSlot } from '@/lib/recipe-role-slots';
import { useChannelLabel } from '@/lib/channel-label';
import { useFlatHref } from '@/hooks/use-flat-href';
import { stageRoleLabel } from '@/lib/stage-role';
import { recipeStageLabel } from '@/lib/recipe-stage-label';
import { gateApproverLabel } from '@/lib/gate-approver-label';
import { useRecipeMemberOptions } from '@/hooks/use-recipe-member-options';
import { presetName } from '@/lib/platform-preset-copy';
import { useFlatHref } from '@/hooks/use-flat-href';

// story #4048(E-RECIPE-1 ①) — 레시피 적용 다이얼로그. story #4173(E-RECIPE-2)부터 자리는
// 정의(stage_metadata·role_actor_kinds·payload_schema 흐름)로 구동한다 — 영상 레시피 4슬롯
// 고정·레시피 전용 상수 없이, recipeRoleSlots()가 역할의 stage를 방식별 자리로 나눠 그린다
// (한 역할에 방식이 다른 stage가 있으면 자리가 여럿):
//   · member = role_binding(팀 멤버) — apply_recipe_role_bindings 제출.
//   · approver = 게이트 승인 주체 — stage_metadata.gate.approver를 읽기 전용으로.
//   · compute·channel = 연산 커넥터·채널 연결.
// 어느 자리든 제출 값은 그 자리의 stage에만 꽂힌다(stage→값). 자리에 안 덮인 stage가 있으면
// 제출을 막고 보여준다(uncoveredRecipeStages, fail-closed). 역할 순서는 갤러리 카드와 같은
// orderedRecipeRoles()(사람 먼저 → 흐름 순서), 역할 안 자리 순서는 첫 stage 흐름 순서.
// 자리가 둘 이상인 역할은 역할 이름을 묶음 머리에 한 번, 자리는 그 아래 줄로(유나 판정 §9).

export interface MarketingRecipeApplyDialogProps {
  recipe: (EventDefinitionResponse & { id: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: { id: string; name: string }[];
  // story #4103(#4090 AC1 잔여, 페드루 PO 실측 2026-09-21) — 발행자 슬롯(채널 연결)
  // 목록을 org 스코프로 불러오는 데 필요(apply-recipe-dialog.tsx와 동형).
  orgId?: string;
  // story #4107 — apply 응답의 준비 경고(warnings, BE 카탈로그 문장·재가공 0)를 다이얼로그
  // 결과 영역에 표시하기 위한 필드. 경고가 있어도 적용 자체는 성공(BE 계약 그대로 — 막지
  // 않음, ok/bindingsUpserted와 별개 축).
  onSubmit: (args: { recipeId: string; projectId: string; roleMapping: Record<string, string> }) => Promise<{ ok: boolean; error?: string; bindingsUpserted?: number; warnings?: string[] }>;
}

interface ChannelConnectionOption {
  id: string;
  channel: string;
  account_label: string | null;
  account_id: string;
  status: string;
}

// story #4114 — GET .../generation-connectors 응답의 부분집합(recipe-role-mapping-fields.tsx
// ::GenerationConnectorOption과 동형 필드, 이 파일은 ChannelConnectionOption처럼 로컬
// 정의를 관례로 따른다).
interface GenerationConnectorOption {
  id: string;
  provider_key: string;
  label: string;
  status: string;
}

export function MarketingRecipeApplyDialog({
  recipe, open, onOpenChange, projects, orgId, onSubmit,
}: MarketingRecipeApplyDialogProps) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  const tPreset = useTranslations('recipePreset');
  // story #4103 CHANGES-1(페드루 PO 리뷰, 2026-09-21) — channelConnect ns의 기존
  // channelLoadFailed 키 재사용(신규 문구 발명 0).
  const tChannel = useTranslations('channelConnect');
  const channelLabel = useChannelLabel();
  const locale = useLocale();
  const flatHref = useFlatHref();
  // story #4239(유나 확정) — «이 레시피는 {channels} 연결이 필요해요»의 {channels}: 테스트 채널(sandbox · *_sandbox)은 뺀다
  // (테스트 연결이 있으면 선택지가 안 비어 이 안내가 뜨지 않으니 빼도 거짓이 아님) · 표시 이름 · 같은 이름 한 번 · 정의 순서 ·
  // «또는»으로 묶는다(하나만 연결해도 된다 — « · »는 «모두 필요»로 읽힌다). 빼고 나서 비면 null(기존 «연결 없음» 문장으로).
  const neededChannelsPhrase = (allowed: string[]): string | null => {
    const names = [...new Set(allowed.filter((c) => c !== 'sandbox' && !c.endsWith('_sandbox')).map(channelLabel))];
    if (names.length === 0) return null;
    return new Intl.ListFormat(locale, { type: 'disjunction' }).format(names);
  };
  const [projectId, setProjectId] = useState('');
  // story #4173 — 자리(slot.key = 역할+방식)별 선택값. member 자리는 팀 멤버 id, channel은
  // 채널 연결 id, compute는 연산 커넥터 id. approver 자리는 읽기 전용이라 값이 없다.
  const [selections, setSelections] = useState<Record<string, string>>({});
  // story #4103 — apply-recipe-dialog.tsx와 동형(org 스코프, project 무관, 다이얼로그
  // open 시 1회).
  const [channelConnections, setChannelConnections] = useState<ChannelConnectionOption[]>([]);
  // story #4103 CHANGES-1 — #3521(유나 §22-2) agentsLoadFailed와 동형: fetch 실패/로딩
  // 中을 "0건"과 구분한다(안 그러면 "없어요"+제출 차단이 네트워크 문제를 «진짜 0건»으로
  // 오독시킨다). 3값 — 로딩 中(초기)·loaded(성공, 빈 배열일 수 있음)·failed(응답
  // !ok 또는 네트워크 reject).
  const [channelConnectionsStatus, setChannelConnectionsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  // story #4114 — 연산 슬롯(channelConnections와 동형 3값 패턴).
  const [generationConnectors, setGenerationConnectors] = useState<GenerationConnectorOption[]>([]);
  const [generationConnectorsStatus, setGenerationConnectorsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // story #4107 — apply-recipe-dialog.tsx(137~143행)와 동형. 경고가 있으면 다이얼로그는
  // 닫지 않고(적용은 이미 성공) 결과 영역에 목록을 보여준다.
  const [warnings, setWarnings] = useState<string[]>([]);

  const { options, loading: loadingMembers } = useRecipeMemberOptions(projectId || null);

  const loadChannelConnections = useCallback(() => {
    if (!orgId) { setChannelConnectionsStatus('loaded'); return; }
    setChannelConnectionsStatus('loading');
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections`);
        if (!res.ok) { setChannelConnectionsStatus('failed'); return; }
        const json = await res.json() as { data?: ChannelConnectionOption[] } | ChannelConnectionOption[];
        setChannelConnections(Array.isArray(json) ? json : (json.data ?? []));
        setChannelConnectionsStatus('loaded');
      } catch {
        setChannelConnectionsStatus('failed');
      }
    })();
  }, [orgId]);

  // story #4114 — loadChannelConnections와 동형(apply-recipe-dialog.tsx의
  // active_only=true 쿼리 재사용, revoked는 BE가 이미 걸러줌).
  const loadGenerationConnectors = useCallback(() => {
    if (!orgId) { setGenerationConnectorsStatus('loaded'); return; }
    setGenerationConnectorsStatus('loading');
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/generation-connectors?active_only=true`);
        if (!res.ok) { setGenerationConnectorsStatus('failed'); return; }
        const json = await res.json() as { data?: { connectors?: GenerationConnectorOption[] } };
        setGenerationConnectors(json.data?.connectors ?? []);
        setGenerationConnectorsStatus('loaded');
      } catch {
        setGenerationConnectorsStatus('failed');
      }
    })();
  }, [orgId]);

  useEffect(() => {
    if (!open) return;
    setProjectId('');
    setSelections({});
    setChannelConnections([]);
    setGenerationConnectors([]);
    setError(null);
    setWarnings([]);
    loadChannelConnections();
    loadGenerationConnectors();
  }, [open, orgId, loadChannelConnections, loadGenerationConnectors]);

  if (!recipe) return null;

  const flow = recipe.payload_schema.properties?.stage?.enum ?? [];
  const slots = recipeRoleSlots(recipe.stage_metadata, flow, recipe.role_actor_kinds);
  const uncovered = uncoveredRecipeStages(recipe.stage_metadata, flow, slots);
  const memberSlots = slots.filter((s) => s.kind === 'member');
  const activeChannelConnections = channelConnections.filter((c) => c.status === 'active');
  const activeGenerationConnectors = generationConnectors.filter((c) => c.status === 'active');
  // 필수 여부 = member 자리는 항상, 연결 자리는 RECIPE_CONNECTION_TARGETS 표(카드와 같은 표).
  const optionalByKind: Record<string, boolean> = {
    channel: RECIPE_CONNECTION_TARGETS.find((c) => c.target === 'channel_connection')!.optional,
    compute: RECIPE_CONNECTION_TARGETS.find((c) => c.target === 'generation_connector')!.optional,
  };
  const requiredSlots = slots.filter((s) => s.kind === 'member' || ((s.kind === 'channel' || s.kind === 'compute') && !optionalByKind[s.kind]));
  const allRequiredChosen = requiredSlots.every((s) => !!selections[s.key]);
  const membersFor = (slot: RecipeRoleSlot) => options.filter((o) => o.type === slot.memberType);

  const select = (key: string, value: string) => setSelections((prev) => ({ ...prev, [key]: value }));

  // 페드루 QA 지적(#4424 qa:changes, 2026-09-19) — 프로젝트 전환 시 이전 멤버 선택이 남아
  // 있으면 <select>는 빈칸으로 보여도 state는 옛 project의 멤버 id를 쥐고 제출된다. 프로젝트가
  // 바뀔 때 멤버 자리 선택만 비운다(채널·연산 연결은 org 스코프라 project와 무관).
  const changeProject = (next: string) => {
    setProjectId(next);
    setSelections((prev) => {
      const kept = { ...prev };
      for (const s of memberSlots) delete kept[s.key];
      return kept;
    });
  };

  const submit = async () => {
    if (!projectId || !allRequiredChosen || uncovered.length > 0) return;
    // 페드루 QA 지적(#4424 qa:changes) — 전환 시 선택을 비우지만 그 방어 하나에만 기대지
    // 않고 제출 시점에도 소속(멤버십)을 다시 확認한다.
    for (const slot of memberSlots) {
      if (!membersFor(slot).some((m) => m.id === selections[slot.key])) {
        setError(t('recipeApplyV2CreatorMembershipError'));
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    setWarnings([]);
    try {
      // 자리마다 그 자리의 stage에만 값을 꽂는다(apply-recipe-dialog.tsx RecipeRoleMappingFields와
      // 동형 계약 — stage→값). 역할 전체로 펼치지 않는다 — 한 역할이 멤버·채널 자리를 같이
      // 가지면 채널 stage에 멤버 id가 들어가면 안 된다. 연산은 비우면 그 stage를 아예 안
      // 보낸다(빈 문자열은 BE uuid 파싱에서 죽고, 안 보내야 #4110 crew 폴백이 동작한다).
      const roleMapping: Record<string, string> = {};
      for (const slot of slots) {
        if (slot.kind === 'approver' || slot.kind === 'approval_elsewhere') continue;
        const value = selections[slot.key];
        if (!value) continue;
        for (const stage of slot.stages) roleMapping[stage] = value;
      }
      // 카디르 P1 재현(#4426) — 매핑이 비면 서버까지 보내지 않고 즉시 막는다.
      if (Object.keys(roleMapping).length === 0) {
        setError(t('recipeApplyV2NoOpError'));
        return;
      }
      const result = await onSubmit({ recipeId: recipe.id, projectId, roleMapping });
      if (!result.ok) {
        setError(result.error ?? t('eventApplyErrorGeneric'));
        return;
      }
      // ok=true·bindings_upserted=0이 동시에 성립할 수 있다(ApplyRecipeRoleBindingsResponse).
      if ((result.bindingsUpserted ?? 0) === 0) {
        setError(t('recipeApplyV2NoOpError'));
        return;
      }
      // story #4107 — 경고가 있으면 닫지 않고 사용자가 경고를 본 뒤 스스로 닫게 한다.
      if ((result.warnings ?? []).length > 0) {
        setWarnings(result.warnings ?? []);
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const stageList = (slot: RecipeRoleSlot) => slot.stages.map((s) => recipeStageLabel(s, t)).join(' · ');

  // 자리 한 줄. 자리 하나인 역할은 지금 모양 그대로(테두리 카드 + 역할 이름 + 배지). 자리가 둘
  // 이상인 역할의 줄(`grouped`)은 역할 이름을 묶음 머리로 올리고 배지 + 맡은 단계 « · » + 선택기만
  // 싣는다 — 줄 사이는 border-t(유나 판정 §9).
  const badgeFor = (slot: RecipeRoleSlot) => {
    if (slot.kind === 'approver' || slot.kind === 'approval_elsewhere') return t('recipeApplyV2DirectorBadge');
    if (slot.kind === 'member') return slot.memberType === 'human' ? t('recipeApplyV2DirectorBadge') : t('recipeApplyV2CreatorBadge');
    if (slot.kind === 'compute') return t('recipeApplyV2ComputeBadge');
    return t('recipeApplyV2PublisherBadge');
  };

  const renderSlot = (slot: RecipeRoleSlot, grouped = false, first = true) => {
    const title = stageRoleLabel(slot.role, t);
    // 묶음 안 선택기는 역할 이름만으론 서로 구분이 안 된다(같은 역할 아래 줄 여럿) — 방식 배지를 붙인다.
    const controlLabel = grouped ? `${title} · ${badgeFor(slot)}` : title;
    const rowClass = grouped
      ? `flex items-center gap-3 p-3${first ? '' : ' border-t border-input'}`
      : 'flex items-center gap-3 rounded-md border border-input p-3';
    const heading = () => (
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {grouped ? null : <>{title} </>}<Badge variant="secondary">{badgeFor(slot)}</Badge>
      </div>
    );
    const rowAttrs = { className: rowClass, 'data-role': slot.role, 'data-slot-key': slot.key };
    if (slot.kind === 'approver') {
      // 게이트 승인 주체 — 읽기 전용(role_mapping 축 아님). story #4087 — raw approver 키
      // 대신 gate-approver-label.ts SSOT 사람 낱말, 라벨 기준 dedupe.
      const approvers = Array.from(new Set(slot.gateApprovers.map((a) => gateApproverLabel(t, a))));
      return (
        <div key={slot.key} {...rowAttrs} data-testid="slot-director">
          <div className="min-w-0 flex-1 break-keep">
            {heading()}
            <p className="mt-0.5 text-xs text-muted-foreground">{stageList(slot)}</p>
          </div>
          <div className="shrink-0 text-xs text-muted-foreground" data-testid="director-approver">
            {approvers.length > 0 ? approvers.join(', ') : '—'}
          </div>
        </div>
      );
    }
    if (slot.kind === 'approval_elsewhere') {
      // story #4174 후속 — 승인이 이 stage 밖(결재함의 초안)에서 일어나는 사람 stage. 고를 사람이 없어 선택기 없음 ·
      // 필수 아님 · role_mapping에 안 실림(승인자는 초안 게이트 쪽 규칙이 정한다).
      return (
        <div key={slot.key} {...rowAttrs} data-testid="slot-approval-elsewhere">
          <div className="min-w-0 flex-1 break-keep">
            {heading()}
            <p className="mt-0.5 text-xs text-muted-foreground">{stageList(slot)}</p>
          </div>
          <div className="shrink-0 break-keep text-xs text-muted-foreground" data-testid="approval-elsewhere-note">
            {t('recipeApplyV2ApprovalOnDraftGate')}
          </div>
        </div>
      );
    }
    if (slot.kind === 'member') {
      const members = membersFor(slot);
      return (
        <div key={slot.key} {...rowAttrs} data-testid="slot-creator">
          <div className="min-w-0 flex-1 break-keep">
            {heading()}
            <p className="mt-0.5 text-xs text-muted-foreground">{stageList(slot)}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('recipeApplyV2StageCoverage', { count: slot.stages.length })}</p>
          </div>
          <select
            className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={selections[slot.key] ?? ''}
            onChange={(e) => select(slot.key, e.target.value)}
            disabled={!projectId || loadingMembers}
            aria-label={controlLabel}
            data-testid="creator-agent-select"
          >
            <option value="">{t('eventApplyAgentPlaceholder')}</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      );
    }
    if (slot.kind === 'compute') {
      return (
        <div key={slot.key} {...rowAttrs} data-testid="slot-compute">
          <div className="min-w-0 flex-1 break-keep">
            {heading()}
            <p className="mt-0.5 text-xs text-muted-foreground">{grouped ? stageList(slot) : t('recipeApplyV2ComputeDesc')}</p>
            {/* story #4114 — 3값 우선순위(failed > loaded+0건 > 없음). 연산은 필수가 아니므로
                (#4110 crew 폴백) 아래 안내 문구가 항상 함께 "비워도 되는" 이유를 설명한다. */}
            {generationConnectorsStatus === 'failed' ? (
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="marketing-apply-generation-connectors-load-error">
                <span>{t('eventApplyGenerationConnectorsLoadError')}</span>
                <Button variant="outline" size="sm" onClick={loadGenerationConnectors}>{t('eventApplyAgentsRetry')}</Button>
              </div>
            ) : generationConnectorsStatus === 'loaded' && activeGenerationConnectors.length === 0 ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="marketing-apply-generation-connectors-empty">
                {t('eventApplyGenerationConnectorsEmpty')}{' '}
                <Link href={flatHref('/organization/generation-connectors')} className="text-primary underline">
                  {t('eventApplyGenerationConnectorsEmptyLinkAction')}
                </Link>
              </p>
            ) : null}
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('recipeApplyV2ComputeEmptyFallbackHint')}</p>
          </div>
          <select
            className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={selections[slot.key] ?? ''}
            onChange={(e) => select(slot.key, e.target.value)}
            disabled={generationConnectorsStatus !== 'loaded'}
            aria-label={controlLabel}
            data-testid="compute-connector-select"
          >
            <option value="">{t('eventApplyGenerationConnectorPlaceholder')}</option>
            {activeGenerationConnectors.map((c) => (
              <option key={c.id} value={c.id}>{c.label || c.provider_key}</option>
            ))}
          </select>
        </div>
      );
    }
    // story #4239 — 이 자리 stage가 허용 채널 종류를 선언했으면 그 종류의 연결만 보여준다(적용 API도 밖이면 422).
    const allowedChannels = allowedChannelsForSlot(slot, recipe.stage_metadata);
    const slotConnections = allowedChannels
      ? activeChannelConnections.filter((c) => allowedChannels.includes(c.channel))
      : activeChannelConnections;
    return (
      <div key={slot.key} {...rowAttrs} data-testid="slot-publisher">
        <div className="min-w-0 flex-1 break-keep">
          {heading()}
          <p className="mt-0.5 text-xs text-muted-foreground">{grouped ? stageList(slot) : t('recipeApplyV2PublisherDesc')}</p>
          {/* story #4103 CHANGES-1 — 로딩 中엔 문구 없음, failed는 재시도, loaded+0건만 empty. */}
          {channelConnectionsStatus === 'failed' ? (
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="marketing-apply-channels-load-error">
              <span>{tChannel('channelLoadFailed')}</span>
              <Button variant="outline" size="sm" onClick={loadChannelConnections}>{t('eventApplyAgentsRetry')}</Button>
            </div>
          ) : channelConnectionsStatus === 'loaded' && slotConnections.length === 0 ? (
            allowedChannels && neededChannelsPhrase(allowedChannels) ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="marketing-apply-channels-none-allowed">
                {t('recipeApplyV2ChannelsNoneAllowed', { channels: neededChannelsPhrase(allowedChannels)! })}{' '}
                <Link href={flatHref('/organization/channels')} className="whitespace-nowrap font-medium text-primary hover:underline">
                  {t('recipeApplyV2ChannelsConnectLink')}
                </Link>
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="marketing-apply-channels-empty">
                {t('eventApplyChannelsEmpty')}
              </p>
            )
          ) : null}
        </div>
        <select
          className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          value={selections[slot.key] ?? ''}
          onChange={(e) => select(slot.key, e.target.value)}
          // 유나 4598 비차단 — 고를 연결이 0개면 상자도 닫는다(옆 안내가 사유).
          disabled={channelConnectionsStatus !== 'loaded' || slotConnections.length === 0}
          aria-label={controlLabel}
          data-testid="publisher-connection-select"
        >
          <option value="">{t('eventApplyChannelPlaceholder')}</option>
          {slotConnections.map((c) => (
            <option key={c.id} value={c.id}>{c.account_label || `${c.channel}(${c.account_id})`}</option>
          ))}
        </select>
      </div>
    );
  };

  // 역할별로 묶는다(slots는 이미 역할 순서 → 역할 안 흐름 순서). 자리 하나면 그 줄 그대로,
  // 둘 이상이면 role="group" 묶음(머리 제목 aria-labelledby) 아래 줄로.
  const roleGroups: RecipeRoleSlot[][] = [];
  for (const slot of slots) {
    const last = roleGroups[roleGroups.length - 1];
    if (last && last[0]!.role === slot.role) last.push(slot);
    else roleGroups.push([slot]);
  }
  const renderRoleGroup = (group: RecipeRoleSlot[], index: number) => {
    if (group.length === 1) return renderSlot(group[0]!);
    const role = group[0]!.role;
    // role은 정의 저자가 적는 자유 문자열(공백 등)이라 id엔 순번을 쓴다.
    const headingId = `recipe-apply-role-group-${index}`;
    return (
      <div key={role} role="group" aria-labelledby={headingId} className="rounded-md border border-input" data-testid="slot-group" data-role={role}>
        <div id={headingId} className="break-keep px-3 pt-3 text-sm font-semibold text-foreground">{stageRoleLabel(role, t)}</div>
        {group.map((slot, i) => renderSlot(slot, true, i === 0))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('recipeApplyV2Title', { name: presetName(recipe, tPreset) })}</DialogTitle>
          <DialogDescription>{t('recipeApplyV2Description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="marketing-recipe-apply-project" className="text-xs font-medium text-muted-foreground">
            {t('eventApplyProjectLabel')}
          </label>
          <select
            id="marketing-recipe-apply-project"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={projectId}
            onChange={(e) => changeProject(e.target.value)}
          >
            <option value="">{t('eventApplyProjectPlaceholder')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className="space-y-2.5">
          {roleGroups.map(renderRoleGroup)}
        </div>

        {uncovered.length > 0 ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground" data-testid="marketing-apply-uncovered-stages">
            {t('recipeApplyV2UncoveredStages', { stages: uncovered.map((s) => recipeStageLabel(s, t)).join(' · ') })}
          </p>
        ) : null}

        {warnings.length > 0 ? (
          <div className="space-y-1 rounded-md border border-warning-border bg-warning-tint p-2 text-xs text-foreground" data-testid="marketing-apply-warnings">
            {/* 페드루 PO CHANGES(PR #4484 리뷰, 2026-09-21) — 서버엔 이미 저장됐다. "적용됐어요
                — 확認할 것"으로 결과를 먼저 명시한다. */}
            <p className="font-medium text-warning-strong">{t('recipeApplyV2WarningsAppliedHeading')}</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        ) : null}

        {error ? (
          <p role="alert" aria-live="assertive" className="rounded-md border border-destructive/30 bg-destructive-tint px-3 py-2 text-xs text-foreground">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {/* 페드루 PO CHANGES(PR #4484 리뷰) — 경고 상태에선 저장이 이미 끝났다. «확認» 단일
              버튼만 보여주고 onOpenChange(false)가 페이지의 보류된 성공 처리를 태운다. */}
          {warnings.length > 0 ? (
            <Button onClick={() => onOpenChange(false)} data-testid="marketing-apply-warnings-confirm">
              {tc('confirm')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{tc('cancel')}</Button>
              <Button onClick={() => void submit()} disabled={submitting || !projectId || !allRequiredChosen || uncovered.length > 0}>
                {submitting ? t('eventApplySubmitting') : t('eventApplySubmit')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** MarketingRecipeApplyDialog의 onSubmit 구현을 표준 계약(POST .../apply)으로 감싼다 —
 * 페이지가 직접 fetch 배선을 새로 쓰지 않고 이걸 넘기면 된다(apply-recipe-dialog.tsx와
 * 동일 엔드포인트·바디 shape, 신규 백엔드 없음). */
export async function submitMarketingRecipeApply(
  { recipeId, projectId, roleMapping }: { recipeId: string; projectId: string; roleMapping: Record<string, string> },
): Promise<{ ok: boolean; error?: string; bindingsUpserted?: number; warnings?: string[] }> {
  const res = await fetchWithAuth(`/api/events/definitions/${recipeId}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, role_mapping: roleMapping }),
  });
  // story #4424 CI 실측(no-fetch-response-without-ok-check, 2026-09-19) — res.ok 검사를
  // .json() 앞으로 옮긴다(가드 300자 윈도우 근접 미스가 아니라, 실패 바디도 에러 메시지
  // 추출을 위해 파싱은 하되 그 판단이 res.ok 분기 안에서 먼저 이뤄지게 명시).
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
    return { ok: false, error: errBody.error?.message };
  }
  // 카디르 P1(#4426, 2026-09-19) — ApplyRecipeRoleBindingsResponse(events.py)는
  // bindings_upserted(int)를 실 필드로 낸다. ok=true는 요청 자체가 성공했다는 뜻일 뿐
  // 실제 배정 건수와 무관해 그대로 통과시키지 않고 호출부에 넘겨 판단하게 한다.
  const data = await res.json().catch(() => ({})) as {
    ok?: boolean; bindings_upserted?: number; warnings?: string[]; error?: { message?: string };
  };
  if (!data.ok) return { ok: false, error: data.error?.message };
  return { ok: true, bindingsUpserted: data.bindings_upserted, warnings: data.warnings };
}
