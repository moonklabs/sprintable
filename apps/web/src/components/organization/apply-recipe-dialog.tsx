'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { cyclicStages, type EventDefinitionResponse } from '@/components/loops/loop-create-dialog';
import { RecipeRoleMappingFields, type ChannelConnectionOption, type GenerationConnectorOption } from '@/components/organization/recipe-role-mapping-fields';
import type { useToast } from '@/components/ui/toast';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';

interface AgentOption {
  id: string;
  name: string;
}

// story #3316 — organization/events 카탈로그에 빠져 있던 "프로젝트에 적용" 진입점. gallery
// (workflow-template-gallery-section.tsx, 프로젝트 설정 화면)는 이미 프로젝트 컨텍스트 안이라
// projectId를 props로 받지만, 이 다이얼로그는 org 레벨 카탈로그에서 열리므로 프로젝트 자체를
// 먼저 골라야 한다 — 그 한 가지 차이 말고는 role_mapping 입력/적용/warnings 렌더 전부 gallery와
// 동일 계약(POST .../apply body {project_id, role_mapping} 그대로 재사용, 신규 엔드포인트 없음).
export function ApplyRecipeDialog({
  target, open, onOpenChange, t, tc, addToast,
}: {
  target: (EventDefinitionResponse & { id: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  addToast: ReturnType<typeof useToast>['addToast'];
}) {
  const { orgId } = useDashboardContext();
  // story #4106(페드루 PO 실측 2026-09-21, PR #4478/#4479 리뷰 계기) — channelConnect ns의
  // 기존 channelLoadFailed 키 재사용(#4103과 동형, 신규 문구 발명 0).
  const tChannel = useTranslations('channelConnect');
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  const [agents, setAgents] = useState<AgentOption[]>([]);
  // story #4090(alembic 0385) — org 스코프(project 무관, channel-connections는 org
  // 소속)라 project 전환 useEffect가 아니라 다이얼로그 open 시 1회만 불러온다.
  const [channelConnections, setChannelConnections] = useState<ChannelConnectionOption[]>([]);
  // story #4101 — 같은 org 스코프 원칙(project 무관, 다이얼로그 open 시 1회).
  const [generationConnectors, setGenerationConnectors] = useState<GenerationConnectorOption[]>([]);
  // story #4106 — #3521 agentsLoadFailed와 동형 축을 채널·연산 두 leg에도: fetch 실패/
  // 로딩 中을 "0건"과 구분한다(안 그러면 «없어요»+플래시가 네트워크 문제를 진짜 0건으로
  // 오독시킨다). 3값 — 로딩 中(초기)·loaded(성공, 빈 배열일 수 있음)·failed.
  const [channelConnectionsStatus, setChannelConnectionsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [generationConnectorsStatus, setGenerationConnectorsStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [roleMapping, setRoleMapping] = useState<Record<string, string>>({});
  const [loadingProjectData, setLoadingProjectData] = useState(false);
  // story #3521(유나 §22-2, PO 確定 2026-09-05) — memberRes leg 실패 여부. agents=[]가
  // 진짜 0명인지 못 불러온 건지 갈라야 select 옆 문구가 정직해진다.
  const [agentsLoadFailed, setAgentsLoadFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const loadChannelConnections = useCallback(() => {
    if (!orgId) { setChannelConnectionsStatus('loaded'); return; }
    setChannelConnectionsStatus('loading');
    void (async () => {
      try {
        // story #4090 — org 스코프 목록이라 project 선택과 무관하게 1회만(휴먼용 목록,
        // organization/channels 화면과 동일 BFF — agent-visible 별도 축은 이 화면이
        // 아니다).
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

  const loadGenerationConnectors = useCallback(() => {
    if (!orgId) { setGenerationConnectorsStatus('loaded'); return; }
    setGenerationConnectorsStatus('loading');
    void (async () => {
      try {
        // story #4101 — active_only=true(revoked는 애초에 선택지 밖, RecipeRoleMappingFields
        // 의 status 필터와 이중 방어 — BE가 이미 걸러 주면 FE 필터는 no-op).
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
    setAgents([]);
    setChannelConnections([]);
    setGenerationConnectors([]);
    setRoleMapping({});
    setError(null);
    setWarnings([]);
    void (async () => {
      const res = await fetchWithAuth('/api/projects');
      if (!res.ok) return;
      const json = await res.json() as { data?: { id: string; name: string }[] };
      setProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    })();
    loadChannelConnections();
    loadGenerationConnectors();
  }, [open, orgId, loadChannelConnections, loadGenerationConnectors]);

  const loadProjectData = useCallback(() => {
    if (!projectId || !target) { setAgents([]); setRoleMapping({}); setAgentsLoadFailed(false); return; }
    setLoadingProjectData(true);
    setError(null);
    setWarnings([]);
    setAgentsLoadFailed(false);
    void (async () => {
      try {
        // story #3519(§16-7 2부, PO 確定 2026-09-05) — 둘 다 부수(ok?채움:빈값)인데 격리
        // 없이 같은 Promise.all 안에 있어, 하나가 네트워크단 reject하면 나머지도 조용히
        // 빈 값이 됐다 — "에이전트 없음"처럼 보이지만 실은 네트워크 실패인 자리.
        const [memberRes, bindingsRes] = await Promise.all([
          fetchWithAuth(`/api/team-members?project_id=${projectId}&type=agent`).catch(() => null),
          fetchWithAuth(`/api/events/definitions/${target.id}/bindings?project_id=${projectId}`).catch(() => null),
        ]);
        // story #3521(유나 §22-2, PO 確定 2026-09-05) — memberRes 실패는 "에이전트 없음"
        // (진짜 0명)과 다른 사실이다. 여기서만 갈린다 — agents가 빈 배열인 건 둘 다
        // 동일하니 별도 플래그로 원인을 들고 나간다.
        if (memberRes?.ok) {
          const json = await memberRes.json() as { data?: AgentOption[] } | AgentOption[];
          setAgents(Array.isArray(json) ? json : (json.data ?? []));
        } else {
          setAgents([]);
          setAgentsLoadFailed(true);
        }
        if (bindingsRes?.ok) {
          const j = await bindingsRes.json() as { bindings?: Record<string, string> };
          setRoleMapping(j.bindings ?? {});
        } else {
          setRoleMapping({});
        }
      } finally {
        setLoadingProjectData(false);
      }
    })();
  }, [projectId, target]);

  useEffect(() => { loadProjectData(); }, [loadProjectData]);

  if (!target) return null;
  const stages = cyclicStages(target);
  // story #4090 — 채널-대상 stage가 아예 없는 정의(레시피 1호 외 대부분)면 채널 목록
  // 로딩/빈 상태 문구 자체가 노이즈다(#4075 "0건이면 섹션 숨김" 원칙과 동형).
  const hasChannelStage = stages.some((s) => target.stage_metadata[s]?.capability?.target === 'channel_connection');
  // story #4101 — 같은 원칙, generation_connector 대상 stage가 없는 정의면 연산 커넥터
  // 목록/빈 상태 문구 자체를 안 그린다.
  const hasGenerationStage = stages.some((s) => target.stage_metadata[s]?.capability?.target === 'generation_connector');

  const submit = async () => {
    if (!projectId) return;
    const missing = stages.filter((s) => !roleMapping[s]);
    if (missing.length > 0) {
      setError(t('eventApplyMissingRoles', { stages: missing.join(', ') }));
      return;
    }
    setApplying(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await fetchWithAuth(`/api/events/definitions/${target.id}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, role_mapping: roleMapping }),
      });
      const data = await res.json() as {
        ok?: boolean; bindings_upserted?: number; warnings?: string[]; error?: { message?: string };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error?.message ?? t('eventApplyErrorGeneric'));
      }
      if ((data.warnings ?? []).length > 0) {
        setWarnings(data.warnings ?? []);
      } else {
        addToast({ type: 'success', title: t('eventApplySuccessToast', { count: data.bindings_upserted ?? 0 }) });
        onOpenChange(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('eventApplyErrorGeneric'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!applying) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('eventApplyDialogTitle', { name: target.name || target.key })}</DialogTitle>
          <DialogDescription>{t('eventApplyRoleMappingHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label htmlFor="apply-recipe-project" className="text-xs font-medium text-muted-foreground">
            {t('eventApplyProjectLabel')}
          </label>
          <select
            id="apply-recipe-project"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t('eventApplyProjectPlaceholder')}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        {!projectId ? (
          <p className="text-xs text-muted-foreground">{t('eventApplySelectProjectHint')}</p>
        ) : loadingProjectData ? (
          <p className="text-xs text-muted-foreground">{t('eventApplyLoadingBindings')}</p>
        ) : (
          <div className="space-y-2.5">
            {/* story #3521(유나 §22-2, PO 確定 2026-09-05) — agents=[]의 두 원인(진짜 0명·
                못 불러옴)을 문구로 갈라 select 옆에 둔다. 지금까지 이 자리엔 어느 쪽도
                텍스트가 없었다(조용히 빈 드롭다운). */}
            {agentsLoadFailed ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive-tint px-2.5 py-1.5 text-xs text-foreground" data-testid="apply-recipe-agents-load-error">
                <span>{t('eventApplyAgentsLoadError')}</span>
                <Button variant="outline" size="sm" onClick={loadProjectData}>{t('eventApplyAgentsRetry')}</Button>
              </div>
            ) : agents.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="apply-recipe-agents-empty">{t('eventApplyAgentsEmpty')}</p>
            ) : null}
            {/* story #4106(페드루 PO 실측, PR #4478/#4479 리뷰 계기) — hasChannelStage/
                hasGenerationStage는 무변(0건이면 섹션 자체를 숨긴다는 #4075/#4090 원칙
                그대로), 그 안에서 fetch 실패/로딩 中을 "0건"과 갈랐을 뿐 — #3521
                agentsLoadFailed와 동형 3값. 로딩 中엔 문장 0(성공/실패를 아직 모르는데
                먼저 보이면 오독), failed면 실패 문구+재시도, loaded인데 0건일 때만
                기존 empty 문구. */}
            {hasChannelStage && channelConnectionsStatus === 'failed' ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive-tint px-2.5 py-1.5 text-xs text-foreground" data-testid="apply-recipe-channels-load-error">
                <span>{tChannel('channelLoadFailed')}</span>
                <Button variant="outline" size="sm" onClick={loadChannelConnections}>{t('eventApplyAgentsRetry')}</Button>
              </div>
            ) : hasChannelStage && channelConnectionsStatus === 'loaded' && channelConnections.filter((c) => c.status === 'active').length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="apply-recipe-channels-empty">{t('eventApplyChannelsEmpty')}</p>
            ) : null}
            {hasGenerationStage && generationConnectorsStatus === 'failed' ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive-tint px-2.5 py-1.5 text-xs text-foreground" data-testid="apply-recipe-generation-connectors-load-error">
                <span>{t('eventApplyGenerationConnectorsLoadError')}</span>
                <Button variant="outline" size="sm" onClick={loadGenerationConnectors}>{t('eventApplyAgentsRetry')}</Button>
              </div>
            ) : hasGenerationStage && generationConnectorsStatus === 'loaded' && generationConnectors.filter((c) => c.status === 'active').length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="apply-recipe-generation-connectors-empty">{t('eventApplyGenerationConnectorsEmpty')}</p>
            ) : null}
            <RecipeRoleMappingFields
              stages={stages}
              stageMetadata={target.stage_metadata}
              agents={agents}
              channelConnections={channelConnections}
              generationConnectors={generationConnectors}
              roleMapping={roleMapping}
              onChange={(stage, value) => setRoleMapping((prev) => ({ ...prev, [stage]: value }))}
              agentPlaceholder={t('eventApplyAgentPlaceholder')}
              channelPlaceholder={t('eventApplyChannelPlaceholder')}
              generationConnectorPlaceholder={t('eventApplyGenerationConnectorPlaceholder')}
            />
          </div>
        )}

        {warnings.length > 0 ? (
          <div className="space-y-1 rounded-md border border-warning-border bg-warning-tint p-2 text-xs text-foreground">
            <p className="font-medium text-warning-strong">{t('eventApplyWarningsHeading')}</p>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>{tc('cancel')}</Button>
          <Button
            onClick={() => void submit()}
            disabled={applying || !projectId || loadingProjectData || stages.some((s) => !roleMapping[s])}
          >
            {applying ? t('eventApplySubmitting') : t('eventApplySubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
