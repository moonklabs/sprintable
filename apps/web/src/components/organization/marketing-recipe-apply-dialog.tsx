'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import type { EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { expandRoleSlotBindings, groupStagesByRole, stagesWithGate } from '@/lib/recipe-role-slots';
import { gateApproverLabel } from '@/lib/gate-approver-label';
import { useRecipeMemberOptions } from '@/hooks/use-recipe-member-options';

// story #4048(E-RECIPE-1 ①) — 유나 v2 시안(artifact be718c0a §2) 4슬롯 적용 다이얼로그.
// PO 判定(story #4046, 2026-09-18) 그대로 — 네 슬롯은 각자 다른 메커니즘에 꽂힌다:
//   · 크리에이터 = role_binding(agent_member_id) — apply_recipe_role_bindings 실제 제출.
//     이 다이얼로그에서 유일하게 실제로 배선된 자리.
//   · 디렉터(사람) = 게이트 승인 주체 — stage_metadata.gate.approver에 이미 있는 값을
//     읽기 전용으로 보여준다(stagesWithGate). 새 바인딩 축을 만들지 않는다.
//   · 연산·발행자 = 각자 다른 후속 서브시스템(generation_budget·채널 커넥션) — 이 카드
//     범위 밖(미르코와 인터페이스 확認 필요, story #4046 AC 주석) — 구조만 보여주고
//     picker는 비활성.
//
// `creatorRoleLabel`은 이 레시피의 stage_metadata에서 실제로 "크리에이터" 축에 해당하는
// role 문자열을 호출부가 명시한다(role 라벨은 recipe 저자 자유 문자열이라 컴포넌트가
// 자동 추론하지 않는다 — recipe-role-slots.ts 설계 그대로).

export interface MarketingRecipeApplyDialogProps {
  recipe: (EventDefinitionResponse & { id: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatorRoleLabel: string;
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
  recipe, open, onOpenChange, creatorRoleLabel, projects, orgId, onSubmit,
}: MarketingRecipeApplyDialogProps) {
  const t = useTranslations('organization');
  const tc = useTranslations('common');
  // story #4103 CHANGES-1(페드루 PO 리뷰, 2026-09-21) — channelConnect ns의 기존
  // channelLoadFailed 키 재사용(신규 문구 발명 0).
  const tChannel = useTranslations('channelConnect');
  const [projectId, setProjectId] = useState('');
  const [creatorAgentId, setCreatorAgentId] = useState('');
  // story #4103 — apply-recipe-dialog.tsx와 동형(org 스코프, project 무관, 다이얼로그
  // open 시 1회).
  const [channelConnections, setChannelConnections] = useState<ChannelConnectionOption[]>([]);
  // story #4103 CHANGES-1 — #3521(유나 §22-2) agentsLoadFailed와 동형: fetch 실패/로딩
  // 中을 "0건"과 구분한다(안 그러면 "없어요"+제출 차단이 네트워크 문제를 «진짜 0건»으로
  // 오독시킨다). 3값 — 로딩 中(초기)·loaded(성공, 빈 배열일 수 있음)·failed(응답
  // !ok 또는 네트워크 reject).
  const [channelConnectionsStatus, setChannelConnectionsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [publisherConnectionId, setPublisherConnectionId] = useState('');
  // story #4114 — 연산 슬롯(publisherConnectionId/channelConnections와 동형 3값 패턴).
  const [generationConnectors, setGenerationConnectors] = useState<GenerationConnectorOption[]>([]);
  const [generationConnectorsStatus, setGenerationConnectorsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [computeConnectorId, setComputeConnectorId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // story #4107 — apply-recipe-dialog.tsx(137~143행)와 동형. 경고가 있으면 다이얼로그는
  // 닫지 않고(적용은 이미 성공) 결과 영역에 목록을 보여준다.
  const [warnings, setWarnings] = useState<string[]>([]);

  const { options, loading: loadingMembers } = useRecipeMemberOptions(projectId || null);
  const agentOptions = options.filter((o) => o.type === 'agent');

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
    setCreatorAgentId('');
    setPublisherConnectionId('');
    setChannelConnections([]);
    setComputeConnectorId('');
    setGenerationConnectors([]);
    setError(null);
    setWarnings([]);
    loadChannelConnections();
    loadGenerationConnectors();
  }, [open, orgId, loadChannelConnections, loadGenerationConnectors]);

  // 페드루 QA 지적(#4424 qa:changes, 2026-09-19) — 프로젝트 전환 시 이전 선택이 그대로
  // 남아 있으면(agentOptions가 새 프로젝트 것으로 바뀌어도 creatorAgentId state는 그대로)
  // <select>는 화면상 빈칸으로 보이지만 state는 옛 project의 agent id를 쥐고 있어 제출
  // 시 그대로 실린다. 프로젝트가 바뀔 때마다 선택을 명시적으로 비운다.
  useEffect(() => {
    setCreatorAgentId('');
  }, [projectId]);

  if (!recipe) return null;

  const roleGroups = groupStagesByRole(recipe.stage_metadata);
  const creatorStageCount = roleGroups[creatorRoleLabel]?.length ?? 0;
  const gates = stagesWithGate(recipe.stage_metadata);
  // 디렉터 슬롯 읽기 전용 표시용 — 이 레시피의 게이트 approver들(보통 전부 동일값, org_owner).
  // story #4087 — raw 키를 그대로 join하면 «org_owner»가 노출된다. gate-approver-label.ts
  // SSOT로 사람 낱말화한 뒤 dedupe(라벨 기준 — 서로 다른 raw 키가 같은 미지정 문구로
  // 떨어지는 경우까지 한 줄로 접는다).
  const gateApprovers = Array.from(new Set(gates.map((g) => gateApproverLabel(t, g.gate.approver))));
  // story #4103 — capability.target(닫힌 어휘, #4090 0387)으로 발행자 대상 stage를
  // 판별한다(role 라벨 문자열 매칭 아님 — RecipeRoleMappingFields·apply-recipe-dialog.tsx
  // 와 같은 SSOT 축). 보통 1개(published)지만 정의가 여럿을 선언할 가능성을 배제 안 한다.
  const publisherStages = Object.entries(recipe.stage_metadata)
    .filter(([, meta]) => meta?.capability?.target === 'channel_connection')
    .map(([stage]) => stage);
  const activeChannelConnections = channelConnections.filter((c) => c.status === 'active');
  const publisherRequired = publisherStages.length > 0;
  // story #4114 — 같은 SSOT 축(capability.target, #4090 0387), generation_connector
  // 대상 stage. publisherStages와 달리 «선언했는데 비우면 제출 가능»(#4110 crew 폴백이
  // 있어 필수 아님) — computeRequired는 슬롯 표시 여부에만 쓰고, submit 방어선(아래
  // disabled 조건)에는 안 들어간다.
  const computeStages = Object.entries(recipe.stage_metadata)
    .filter(([, meta]) => meta?.capability?.target === 'generation_connector')
    .map(([stage]) => stage);
  const activeGenerationConnectors = generationConnectors.filter((c) => c.status === 'active');
  const computeRequired = computeStages.length > 0;

  const submit = async () => {
    if (!projectId || !creatorAgentId) return;
    if (publisherRequired && !publisherConnectionId) return;
    // 페드루 QA 지적(#4424 qa:changes) — 위 useEffect가 전환 시 선택을 비우지만, 그
    // 방어 하나에만 기대지 않고 제출 시점에도 소속(멤버십)을 다시 확認한다(fetch race 등
    // 어떤 경로로든 project와 어긋난 agentId가 실리지 않게 하는 마지막 문).
    if (!agentOptions.some((a) => a.id === creatorAgentId)) {
      setError(t('recipeApplyV2CreatorMembershipError'));
      return;
    }
    setSubmitting(true);
    setError(null);
    setWarnings([]);
    try {
      const roleMapping = expandRoleSlotBindings(recipe.stage_metadata, [creatorRoleLabel], {
        [creatorRoleLabel]: creatorAgentId,
      });
      // story #4103 — 발행자(채널 연결)는 role 라벨 그룹 확장 축이 아니라 capability.
      // target=channel_connection stage에 직접 꽂는다(apply-recipe-dialog.tsx의
      // RecipeRoleMappingFields onChange와 동형 계약 — stage→값 그대로).
      if (publisherRequired) {
        for (const stage of publisherStages) roleMapping[stage] = publisherConnectionId;
      }
      // story #4114 — computeConnectorId가 비면 그 stage를 roleMapping에서 아예 뺀다
      // (빈 문자열을 실으면 BE apply_recipe_role_bindings의 uuid.UUID(v) 파싱이
      // ValueError로 죽는다 — «선언했는데 비우면 제출 가능»은 "그 stage를 안 보낸다"로
      // 구현해야 #4110 crew 폴백이 정상 동작한다).
      if (computeRequired && computeConnectorId) {
        for (const stage of computeStages) roleMapping[stage] = computeConnectorId;
      }
      // 카디르 P1 재현(#4426, 2026-09-19) — creatorRoleLabel이 이 레시피의 실제
      // stage_metadata.role 키와 하나도 안 맞으면(예: 표시라벨 vs seed 실제 role 키 불일치
      // 재발) expandRoleSlotBindings가 빈 매핑을 낸다 — 그 상태로 서버까지 보내지 않고
      // 여기서 즉시 막는다(네트워크 왕복 없이 로컬에서 잡는 방어선, [거짓성공표시] 재발 방지).
      if (Object.keys(roleMapping).length === 0) {
        setError(t('recipeApplyV2NoOpError'));
        return;
      }
      const result = await onSubmit({ recipeId: recipe.id, projectId, roleMapping });
      if (!result.ok) {
        setError(result.error ?? t('eventApplyErrorGeneric'));
        return;
      }
      // 위 로컬 방어를 통과했어도 서버가 실제로 0건 upsert했으면(예: 동시성으로 stage가
      // 사라짐 등) 여전히 no-op다 — result.ok만 믿지 않고 bindingsUpserted도 확認한다
      // (백엔드 ApplyRecipeRoleBindingsResponse.ok는 요청 성공 여부일 뿐 실제 배정 건수와
      // 무관 — ok=true·bindings_upserted=0이 동시에 성립할 수 있다).
      if ((result.bindingsUpserted ?? 0) === 0) {
        setError(t('recipeApplyV2NoOpError'));
        return;
      }
      // story #4107 — 경고가 있으면 다이얼로그를 닫지 않는다(apply-recipe-dialog.tsx와
      // 동형). 적용은 이미 성공했으니(bindingsUpserted > 0 통과) 여기서 에러로 취급하지
      // 않고, 사용자가 경고를 본 뒤 스스로 닫게 한다 — 조용한 실패 클래스(이 스토리의
      // 근본 원인)를 막는 지점.
      if ((result.warnings ?? []).length > 0) {
        setWarnings(result.warnings ?? []);
        return;
      }
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('recipeApplyV2Title', { name: recipe.name || recipe.key })}</DialogTitle>
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
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('eventApplyProjectPlaceholder')}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        <div className="space-y-2.5">
          {/* 디렉터 — 읽기 전용(게이트 승인 주체, role_mapping 축 아님) */}
          <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-director">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2DirectorRole')} <Badge variant="secondary">{t('recipeApplyV2DirectorBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2DirectorDesc')}</p>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground" data-testid="director-approver">
              {gateApprovers.length > 0 ? gateApprovers.join(', ') : '—'}
            </div>
          </div>

          {/* 크리에이터 — 실제 role_binding 축 */}
          <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-creator">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2CreatorRole')} <Badge variant="secondary">{t('recipeApplyV2CreatorBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2CreatorDesc')}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('recipeApplyV2StageCoverage', { count: creatorStageCount })}</p>
            </div>
            <select
              className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={creatorAgentId}
              onChange={(e) => setCreatorAgentId(e.target.value)}
              disabled={!projectId || loadingMembers}
              data-testid="creator-agent-select"
            >
              <option value="">{t('eventApplyAgentPlaceholder')}</option>
              {agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>

          {/* 연산 — story #4114(#4101 픽커 배선). 정의가 generation_connector-target
              stage를 선언하지 않으면 슬롯 자체를 숨긴다(publisherRequired와 동형 SSOT
              축이지만, 표시 여부만 같고 필수 여부는 다르다 — 아래 참고). */}
          {computeRequired ? (
            <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-compute">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {t('recipeApplyV2ComputeRole')} <Badge variant="secondary">{t('recipeApplyV2ComputeBadge')}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2ComputeDesc')}</p>
                {/* story #4114 — publisherConnectionId 블록과 동형 3값 우선순위(failed >
                    loaded+0건 > 없음). 연산은 필수가 아니므로(#4110 crew 폴백) 이 안내
                    문구는 항상 함께 보여 "비워도 되는" 이유를 설명한다. */}
                {generationConnectorsStatus === 'failed' ? (
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="marketing-apply-generation-connectors-load-error">
                    <span>{t('eventApplyGenerationConnectorsLoadError')}</span>
                    <Button variant="outline" size="sm" onClick={loadGenerationConnectors}>{t('eventApplyAgentsRetry')}</Button>
                  </div>
                ) : generationConnectorsStatus === 'loaded' && activeGenerationConnectors.length === 0 ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="marketing-apply-generation-connectors-empty">
                    {t('eventApplyGenerationConnectorsEmpty')}{' '}
                    {/* story #4116(#4112 시안 §6) — 빈 상태 문장 끝에 목적지 링크,
                        apply-recipe-dialog.tsx(v1) 동형 배선. */}
                    <Link href="/organization/generation-connectors" className="text-primary underline">
                      {t('eventApplyGenerationConnectorsEmptyLinkAction')}
                    </Link>
                  </p>
                ) : null}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{t('recipeApplyV2ComputeEmptyFallbackHint')}</p>
              </div>
              <select
                className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={computeConnectorId}
                onChange={(e) => setComputeConnectorId(e.target.value)}
                disabled={generationConnectorsStatus !== 'loaded'}
                data-testid="compute-connector-select"
              >
                {/* 유나 문구 확定(2026-09-21 15:11Z) — «모델 세트 선택…» 대신 #4479
                    eventApplyGenerationConnectorPlaceholder와 통일(별도 키 비유지). */}
                <option value="">{t('eventApplyGenerationConnectorPlaceholder')}</option>
                {activeGenerationConnectors.map((c) => (
                  <option key={c.id} value={c.id}>{c.label || c.provider_key}</option>
                ))}
              </select>
            </div>
          ) : null}

          {/* 발행자 — story #4103(#4090 AC1 잔여) — org 채널 연결(active) 실 배선. */}
          <div className="flex items-center gap-3 rounded-md border border-input p-3" data-testid="slot-publisher">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                {t('recipeApplyV2PublisherRole')} <Badge variant="secondary">{t('recipeApplyV2PublisherBadge')}</Badge>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('recipeApplyV2PublisherDesc')}</p>
              {/* story #4103 CHANGES-1(페드루 PO 리뷰) — 3값: 로딩 中엔 아무 문구도
                  안 낸다(성공/실패를 아직 모르는데 "없어요"부터 보이면 오독). failed는
                  네트워크/서버 문제(«0건»과 다른 사실) — agentsLoadFailed(#3521)와
                  동형으로 재시도 버튼. loaded인데 0건일 때만 진짜 empty 문구. */}
              {publisherRequired && channelConnectionsStatus === 'failed' ? (
                <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="marketing-apply-channels-load-error">
                  <span>{tChannel('channelLoadFailed')}</span>
                  <Button variant="outline" size="sm" onClick={loadChannelConnections}>{t('eventApplyAgentsRetry')}</Button>
                </div>
              ) : publisherRequired && channelConnectionsStatus === 'loaded' && activeChannelConnections.length === 0 ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground" data-testid="marketing-apply-channels-empty">
                  {t('eventApplyChannelsEmpty')}
                </p>
              ) : null}
            </div>
            <select
              className="w-44 shrink-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={publisherConnectionId}
              onChange={(e) => setPublisherConnectionId(e.target.value)}
              disabled={!publisherRequired || channelConnectionsStatus !== 'loaded'}
              data-testid="publisher-connection-select"
            >
              <option value="">{t('eventApplyChannelPlaceholder')}</option>
              {activeChannelConnections.map((c) => (
                <option key={c.id} value={c.id}>{c.account_label || `${c.channel}(${c.account_id})`}</option>
              ))}
            </select>
          </div>

          <p className="rounded-md border border-dashed border-input bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
            {t('recipeApplyV2ContractNote')}
          </p>
        </div>

        {warnings.length > 0 ? (
          <div className="space-y-1 rounded-md border border-warning-border bg-warning-tint p-2 text-xs text-foreground" data-testid="marketing-apply-warnings">
            {/* 페드루 PO CHANGES(PR #4484 리뷰, 2026-09-21) — 서버엔 이미 저장됐는데
                («취소»는 거짓 문장) 제목이 중립("주의")이라 사용자가 「아직 적용 전」으로
                오독할 수 있다. "적용됐어요 — 확認할 것"으로 결과를 먼저 명시한다. */}
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
          {/* 페드루 PO CHANGES(PR #4484 리뷰, 2026-09-21) — 경고 상태에선 저장이 이미
              끝났다(bindingsUpserted > 0 통과). «취소»(거짓 문장)·«적용하기»(재클릭 시
              같은 upsert 반복) 둘 다 이 시점엔 잘못된 선택지라 숨기고, 결과를 인지했다는
              «확認» 단일 버튼만 보여준다 — onOpenChange(false)가 페이지의 보류된 성공
              처리(토스트+상세 뷰)를 그제서야 태운다(page.tsx 참고). */}
          {warnings.length > 0 ? (
            <Button onClick={() => onOpenChange(false)} data-testid="marketing-apply-warnings-confirm">
              {tc('confirm')}
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>{tc('cancel')}</Button>
              <Button onClick={() => void submit()} disabled={submitting || !projectId || !creatorAgentId || (publisherRequired && !publisherConnectionId)}>
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
