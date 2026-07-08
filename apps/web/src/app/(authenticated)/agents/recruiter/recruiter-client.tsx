'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Check, CheckCircle2, Copy, Download, RefreshCw, ChevronLeft, Info, Sparkles,
  Palette, Cog, Search, ClipboardList, Briefcase, IdCard,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { cn } from '@/lib/utils';
import {
  VerifyRail, RAIL_ORDER, HTTP_RAIL_ORDER, type DisplayStep, type RailState, type RailStatus,
} from '@/app/onboarding/verify-rail';
import type { RoleTemplateSummary, RecruitResponse, McpConfigBundle, RuntimeCapabilityItem } from '@/services/recruit';
import { RUNTIME_GUIDE_FILENAME_FALLBACK, RUNTIME_CAPABILITIES_FALLBACK } from '@/services/recruit';

// ─── 상수/헬퍼 ──────────────────────────────────────────────────────────────

// story d82c1092(생성경로 단일화): 5-step(직무›스코프›실행환경›번들›검증). equip-skip(역할 없이)
// 경로는 3(직무·스코프·완료)만 쓰고 STEP3을 "결과" 화면으로 재사용한다(runtime 스텝 스킵).
type Step = 1 | 2 | 3 | 4 | 5;

const CATEGORY_ICON: Record<string, typeof Palette> = {
  frontend: Palette,
  backend: Cog,
  qa: Search,
  pm: ClipboardList,
};

const RAIL_LABEL_KEY: Record<RailState, string> = {
  config_copied: 'railConfigCopied',
  waiting: 'railWaiting',
  mcp_reachable: 'railMcpReachable',
  event_delivered: 'railEventDelivered',
  ack: 'railAck',
  verified: 'railVerified',
};

/**
 * rotate 후 실 key 를 mcp_config 에 치환 — 재조립 아닌 필드 치환(connect-step renderArtifact 원칙 동형).
 * 까심 QA RC HIGH①+②: transport별 키 위치가 다르다 — http는 `headers.Authorization`(Bearer 접두),
 * stdio는 `env.AGENT_API_KEY`(접두 없음). 하나만 처리하면 다른 transport에서 화면 키가 조용히
 * stale(회전된 옛 키 그대로 노출)해진다 — 둘 다 처리하고, 어느 쪽도 못 찾으면 null(호출부가 에러로 취급).
 */
export function spliceApiKey(bundle: McpConfigBundle, newKey: string): McpConfigBundle | null {
  const server = bundle.mcpServers.sprintable;
  if (server.headers && 'Authorization' in server.headers) {
    return {
      mcpServers: {
        sprintable: { ...server, headers: { ...server.headers, Authorization: `Bearer ${newKey}` } },
      },
    };
  }
  if (server.env && 'AGENT_API_KEY' in server.env) {
    return {
      mcpServers: {
        sprintable: { ...server, env: { ...server.env, AGENT_API_KEY: newKey } },
      },
    };
  }
  return null;
}

/**
 * E-RECRUIT S6 — `runtime-capabilities` 응답을 STEP2 두 섹션(지원됨/곧지원)으로 분리.
 * 순서는 응답 순서 그대로 보존(BE가 이미 카탈로그 표시 순서로 정렬해 반환한다고 가정 — 재정렬 안 함).
 */
export function splitRuntimeCapabilities(
  items: RuntimeCapabilityItem[],
): { supported: RuntimeCapabilityItem[]; comingSoon: RuntimeCapabilityItem[] } {
  return {
    supported: items.filter((r) => r.supported),
    comingSoon: items.filter((r) => !r.supported),
  };
}

/**
 * 현재 선택된 runtime이 로드된 지원목록에 없으면(예: 기본값 'claude-code'가 이 환경서 미지원)
 * 첫 지원 런타임으로 보정 — recruit() 400 방지. 지원목록이 비어있으면 현재값 그대로 유지(호출부가
 * "지원 런타임 0개" 상태를 별도로 처리해야 하는 엣지케이스 — 현재는 로딩 실패 폴백이 항상 최소 1개
 * 지원 항목을 포함하므로 실무에선 발생 안 함).
 */
export function pickDefaultRuntime(supported: RuntimeCapabilityItem[], current: string): string {
  if (supported.length === 0) return current;
  if (supported.some((r) => r.slug === current)) return current;
  return supported[0].slug;
}

export interface RoleGroup {
  label: string;
  roles: RoleTemplateSummary[];
}

/**
 * 선생님 피드백(2026-07-07, ~110직군): STEP1 role 카탈로그가 플랫이라 탐색 불가 — division(없으면
 * category로 폴백)으로 그루핑 + 검색(name/description/category/division 부분일치, 대소문자 무시).
 * 그룹 순서는 BE가 이미 반환한 순서(category, name)에서 처음 등장한 순서를 그대로 보존(재정렬 안 함).
 */
export function groupAndFilterRoleTemplates(roles: RoleTemplateSummary[], query: string): RoleGroup[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? roles.filter((r) =>
        r.name.toLowerCase().includes(q)
        || (r.description ?? '').toLowerCase().includes(q)
        || r.category.toLowerCase().includes(q)
        || (r.division ?? '').toLowerCase().includes(q))
    : roles;

  const order: string[] = [];
  const byLabel = new Map<string, RoleTemplateSummary[]>();
  for (const role of filtered) {
    const label = role.division?.trim() || role.category;
    if (!byLabel.has(label)) { byLabel.set(label, []); order.push(label); }
    byLabel.get(label)!.push(role);
  }
  return order.map((label) => ({ label, roles: byLabel.get(label)! }));
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface RawStep {
  state: RailState;
  status: RailStatus;
  reason?: string;
}

// ─── 재사용 하위 컴포넌트 ────────────────────────────────────────────────────

function StepperHeader({ step, stages }: { step: Step; stages: { n: Step; label: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-1 pb-3">
      {stages.map((s, i) => (
        <div key={s.n} className="flex items-center gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold',
              s.n === step && 'border-transparent bg-foreground text-background',
              s.n < step && 'border-success/40 text-success',
              s.n > step && 'border-border text-muted-foreground',
            )}
          >
            {s.n < step ? <Check className="h-3 w-3" aria-hidden /> : s.n}
            {s.label}
          </span>
          {i < stages.length - 1 && <span className="text-muted-foreground">›</span>}
        </div>
      ))}
    </div>
  );
}

function CopyDownloadButtons({
  content, filename, copied, onCopied,
}: { content: string; filename: string; copied: boolean; onCopied: () => void }) {
  const t = useTranslations('recruiter');
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      onCopied();
    } catch {
      // ignore clipboard failure
    }
  };
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
        {copied ? <><Check className="h-3.5 w-3.5" />{t('copied')}</> : <><Copy className="h-3.5 w-3.5" />{t('copy')}</>}
      </Button>
      <Button variant="outline" size="sm" onClick={() => downloadTextFile(filename, content)}>
        <Download className="h-3.5 w-3.5" />{t('download')}
      </Button>
    </div>
  );
}

// ─── 메인 컴포넌트 ───────────────────────────────────────────────────────────

interface RecruiterClientProps {
  projectId: string;
  orgId?: string;
  /** IA 통일(story d63d3f73) — `/agents` 채용 탭에 임베드될 때 상위 셸의 TopBarSlot과
   * 경합하지 않도록 자체 TopBarSlot 렌더를 끈다(단일 소유자 원칙 — top-bar-context는 clearSlot이
   * 무조건적이라 두 인스턴스가 동시에 마운트/언마운트되면 레이스가 난다). */
  showTopBar?: boolean;
  /** 임베드 컨텍스트에서 "목록으로" 나가기 — 지정 시 상단에 노출. */
  onExit?: () => void;
}

export function RecruiterClient({ projectId, showTopBar = true, onExit }: RecruiterClientProps) {
  const t = useTranslations('recruiter');
  const tAgents = useTranslations('agents');
  // story d82c1092: 스코프 step(§3③) 카피는 AddAgentForm에서 그대로 하베스트(신규 토큰 0).
  const tSettings = useTranslations('settings');
  // 오르테가 라이브 스모크 적출(2026-07-06): railXxx/railStageHosted 키는 connect-step이 원래
  // 정의한 'onboarding' 네임스페이스에 있는데 STEP4가 이걸 'agents'(tAgents)로 조회해 전부
  // MISSING_MESSAGE였음 — S4 merge(#1900) 때부터의 잠재 버그. 발견 즉시 여기서 수정.
  const tOnboarding = useTranslations('onboarding');
  const [step, setStep] = useState<Step>(1);

  // STEP 1 — role catalog (+ equip-skip: "역할 없이(키만)")
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplateSummary[] | null>(null);
  const [roleError, setRoleError] = useState(false);
  const [selectedRoleSlug, setSelectedRoleSlug] = useState<string | null>(null);
  const [roleQuery, setRoleQuery] = useState('');
  const [equipSkip, setEquipSkip] = useState(false);

  const fetchRoleTemplates = useCallback(async () => {
    setRoleError(false);
    try {
      const res = await fetch('/api/role-templates');
      if (!res.ok) { setRoleError(true); return; }
      const json = (await res.json()) as { data?: RoleTemplateSummary[] };
      setRoleTemplates(json.data ?? []);
    } catch {
      setRoleError(true);
    }
  }, []);

  useEffect(() => { void fetchRoleTemplates(); }, [fetchRoleTemplates]);

  const selectedRole = roleTemplates?.find((r) => r.slug === selectedRoleSlug) ?? null;
  // 선생님 피드백(2026-07-07): 이전엔 이 제안값을 newAgentName에 실제로 채워 넣어 "이미 입력된 값"처럼
  // 보였음(혼동) — 이제는 placeholder로만 노출하고, 제출 시 입력이 비어있으면 이 값으로 폴백한다.
  const suggestedAgentName = selectedRole ? t('agentNameAutoFill', { role: selectedRole.name }) : '';
  const roleGroups = useMemo(
    () => groupAndFilterRoleTemplates(roleTemplates ?? [], roleQuery),
    [roleTemplates, roleQuery],
  );

  // STEP 2 — 스코프(story d82c1092 · AddAgentForm scope UI 하베스트). default=현 프로젝트
  // pre-select(least surprise·기존 recruiter 단일-프로젝트 동작 보존).
  const [scopeMode, setScopeMode] = useState<'org' | 'projects'>('projects');
  const [scopeProjectIds, setScopeProjectIds] = useState<string[]>([projectId]);
  const [orgProjects, setOrgProjects] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/projects');
      if (!res.ok) return;
      const json = (await res.json()) as { data?: { id: string; name: string }[] };
      setOrgProjects((json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    })();
  }, []);

  const toggleScopeProject = (id: string) =>
    setScopeProjectIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  // equip-skip 전용("역할 없이(키만)" — AddAgentForm 2-phase 결과 UX 그대로 흡수).
  const [equipName, setEquipName] = useState('');
  const [equipRole, setEquipRole] = useState<'member' | 'admin'>('member');
  const [equipCreating, setEquipCreating] = useState(false);
  const [equipError, setEquipError] = useState<string | null>(null);
  const [equipResult, setEquipResult] = useState<{
    name: string;
    fakechat_port: number | null;
    mcp_config: Record<string, unknown> | null;
    api_key: string | null;
  } | null>(null);
  const [equipMcpCopied, setEquipMcpCopied] = useState(false);

  const handleEquipCreate = async () => {
    const name = equipName.trim();
    if (!name) { setEquipError(t('agentNameRequired')); return; }
    if (scopeMode === 'projects' && scopeProjectIds.length === 0) return;
    setEquipCreating(true);
    setEquipError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          role: equipRole,
          scope_mode: scopeMode,
          project_ids: scopeMode === 'projects' ? scopeProjectIds : [],
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { fakechat_port?: number | null; mcp_config?: Record<string, unknown> | null; api_key?: string | null };
        };
        setEquipResult({
          name,
          fakechat_port: json.data?.fakechat_port ?? null,
          mcp_config: json.data?.mcp_config ?? null,
          api_key: json.data?.api_key ?? null,
        });
        setStep(3);
      } else {
        const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setEquipError(json?.error?.message ?? t('recruitFailed'));
      }
    } catch {
      setEquipError(t('recruitFailed'));
    } finally {
      setEquipCreating(false);
    }
  };

  const handleCopyEquipMcp = async () => {
    if (!equipResult?.mcp_config) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(equipResult.mcp_config, null, 2));
      setEquipMcpCopied(true);
      setTimeout(() => setEquipMcpCopied(false), 2000);
    } catch {
      // ignore clipboard failure
    }
  };

  // STEP 3(Full 경로) — runtime + agent(G1). equip-skip은 이 스텝을 건너뛰고 STEP2 이후 바로 생성한다.
  const [runtime, setRuntime] = useState<string>('claude-code');
  // E-RECRUIT S6: BE `GET /api/v2/runtime-capabilities`(agent_runtime.py 레지스트리 노출) 동적 소비.
  // 404(엔드포인트 아직 미배포·디디 미착지)는 "에러"가 아니라 "기능 아직 없음" — 조용히 S4 당시
  // 폴백(Claude Code만 활성)으로 graceful degrade하고 에러 배너를 띄우지 않는다(과장된 고장 인상 방지).
  // 그 외 실패(500·네트워크 예외 — 엔드포인트가 실제로 배포된 후에나 발생 가능)는 핸드오프 §3-4의
  // 명시적 에러 UI(재시도+최소 claude-code 폴백 안내)로 — "정직"하게 안 됨을 알린다.
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<RuntimeCapabilityItem[] | null>(null);
  const [runtimeCapabilitiesError, setRuntimeCapabilitiesError] = useState(false);

  const fetchRuntimeCapabilities = useCallback(async () => {
    setRuntimeCapabilitiesError(false);
    try {
      const res = await fetch('/api/runtime-capabilities');
      if (!res.ok) {
        setRuntimeCapabilities(RUNTIME_CAPABILITIES_FALLBACK);
        if (res.status !== 404) setRuntimeCapabilitiesError(true);
        return;
      }
      const json = (await res.json()) as { data?: RuntimeCapabilityItem[] };
      setRuntimeCapabilities(json.data?.length ? json.data : RUNTIME_CAPABILITIES_FALLBACK);
    } catch {
      setRuntimeCapabilities(RUNTIME_CAPABILITIES_FALLBACK);
      setRuntimeCapabilitiesError(true);
    }
  }, []);

  useEffect(() => { void fetchRuntimeCapabilities(); }, [fetchRuntimeCapabilities]);

  const { supported: supportedRuntimes, comingSoon: comingSoonRuntimes } = useMemo(
    () => splitRuntimeCapabilities(runtimeCapabilities ?? []),
    [runtimeCapabilities],
  );

  // 로드된 목록에 현재 선택값이 없으면(예: 기본값 'claude-code'가 이 org enviro서 미지원) 첫 지원
  // 런타임으로 보정 — recruit() 400 방지.
  useEffect(() => {
    const next = pickDefaultRuntime(supportedRuntimes, runtime);
    if (next !== runtime) setRuntime(next);
  }, [supportedRuntimes, runtime]);

  const [agentMode, setAgentMode] = useState<'new' | 'existing'>('new');
  const [newAgentName, setNewAgentName] = useState('');
  const [existingAgents, setExistingAgents] = useState<{ id: string; name: string }[] | null>(null);
  const [selectedExistingAgentId, setSelectedExistingAgentId] = useState('');
  const [recruiting, setRecruiting] = useState(false);
  const [recruitError, setRecruitError] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState('');

  useEffect(() => {
    if (existingAgents !== null) return;
    void (async () => {
      try {
        // 까심 QA RC HIGH③: project_id 없이 부르면 org 전체(타 프로젝트 포함) 에이전트가 새 — 이 채용
        // 흐름은 현재 프로젝트 스코프라 새로 만들기(scope_mode=projects)와 동일하게 project_id 로 스코프.
        const res = await fetch(`/api/team-members?project_id=${projectId}&type=agent`);
        if (!res.ok) return;
        const json = (await res.json()) as { data?: Array<{ id: string; name: string; type: string }> };
        setExistingAgents((json.data ?? []).filter((m) => m.type === 'agent').map((m) => ({ id: m.id, name: m.name })));
      } catch {
        setExistingAgents([]);
      }
    })();
  }, [existingAgents, projectId]);

  // STEP 3 — bundle result
  const [recruitResult, setRecruitResult] = useState<RecruitResponse | null>(null);
  const [copiedGuide, setCopiedGuide] = useState(false);
  const [copiedMcp, setCopiedMcp] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  // 실측(BE PR #1911): 일반 런타임 지침 파일명은 `prompt_file`(`guide_filename`은 connector 전용
  // "CONNECTOR_SETUP.md") — 당초 안내와 필드명이 달라 실 스키마로 정정.
  const guideFilename = runtimeCapabilities?.find((r) => r.slug === runtime)?.prompt_file
    ?? RUNTIME_GUIDE_FILENAME_FALLBACK[runtime] ?? 'CLAUDE.md';

  const handleRecruit = async () => {
    if (!selectedRoleSlug) return;
    setRecruiting(true);
    setRecruitError(null);
    try {
      let agentId: string;
      let agentName: string;
      if (agentMode === 'new') {
        // 빈 입력 = placeholder(제안값) 그대로 수락 — "가볍고 빠르게"(PO crux①) 유지.
        const name = newAgentName.trim() || suggestedAgentName;
        if (!name) { setRecruitError(t('agentNameRequired')); setRecruiting(false); return; }
        // story d82c1092: 하드코딩(scope_mode:'projects', project_ids:[projectId]) 제거 —
        // STEP2 스코프 값을 그대로 배선(org-scope 생성 능력 복원).
        const createRes = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            scope_mode: scopeMode,
            project_ids: scopeMode === 'projects' ? scopeProjectIds : [],
          }),
        });
        const createJson = (await createRes.json().catch(() => null)) as { data?: { id: string } } | null;
        if (!createRes.ok || !createJson?.data?.id) throw new Error(t('recruitFailed'));
        agentId = createJson.data.id;
        agentName = name;
      } else {
        if (!selectedExistingAgentId) { setRecruitError(t('agentSelectRequired')); setRecruiting(false); return; }
        agentId = selectedExistingAgentId;
        agentName = existingAgents?.find((a) => a.id === agentId)?.name ?? '';
      }

      const recruitRes = await fetch(`/api/agents/${agentId}/recruit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_template_slug: selectedRoleSlug, runtime }),
      });
      const recruitJson = (await recruitRes.json().catch(() => null)) as { data?: RecruitResponse } | null;
      if (!recruitRes.ok || !recruitJson?.data) throw new Error(t('recruitFailed'));

      setRecruitResult(recruitJson.data);
      setActiveAgentName(agentName);
      setCopiedGuide(false);
      setCopiedMcp(false);
      setStep(4);
    } catch (err) {
      setRecruitError(err instanceof Error ? err.message : t('recruitFailed'));
    } finally {
      setRecruiting(false);
    }
  };

  const handleRotateConfirmed = async () => {
    if (!recruitResult) return;
    setRotating(true);
    setRotateError(null);
    try {
      const listRes = await fetch(`/api/agents/${recruitResult.agent_id}/api-keys`);
      const listJson = (await listRes.json().catch(() => null)) as { data?: Array<{ id: string; revoked_at: string | null }> } | null;
      const active = listJson?.data?.find((k) => !k.revoked_at);
      if (!listRes.ok || !active) throw new Error(t('rotateFailed'));

      const rotateRes = await fetch('/api/api-keys/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key_id: active.id }),
      });
      const rotateJson = (await rotateRes.json().catch(() => null)) as { data?: { api_key?: string } } | null;
      const newKey = rotateJson?.data?.api_key;
      if (!rotateRes.ok || !newKey) throw new Error(t('rotateFailed'));

      // 까심 QA RC HIGH①: 두 transport 키 위치 다 처리 실패 시(null) 조용히 stale 화면을 두지 말고 에러로.
      const splicedConfig = spliceApiKey(recruitResult.mcp_config, newKey);
      if (!splicedConfig) throw new Error(t('rotateFailed'));

      setRecruitResult({ ...recruitResult, api_key: newKey, mcp_config: splicedConfig });
      setCopiedMcp(false);
      setShowRotateConfirm(false);
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : t('rotateFailed'));
    } finally {
      setRotating(false);
    }
  };

  // STEP 4 — verify rail (connect-step 재사용 패턴)
  const [beSteps, setBeSteps] = useState<RawStep[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const railOrder = recruitResult?.default_transport === 'http' ? HTTP_RAIL_ORDER : RAIL_ORDER;

  const pollStatus = useCallback(async () => {
    if (!recruitResult) return;
    try {
      const res = await fetch(`/api/agents/${recruitResult.agent_id}/verification-status?transport=${recruitResult.default_transport}`);
      if (!res.ok) return;
      const json = (await res.json()) as { data?: { steps?: RawStep[] } | RawStep[]; steps?: RawStep[] };
      const d = json?.data;
      const raw = (Array.isArray(d) ? d : d?.steps) ?? json?.steps;
      if (Array.isArray(raw)) setBeSteps(raw);
    } catch {
      // swallow — graceful degradation
    }
  }, [recruitResult]);

  useEffect(() => {
    if (step !== 5 || !recruitResult) return;
    void pollStatus();
    const iv = setInterval(() => void pollStatus(), 2500);
    return () => clearInterval(iv);
  }, [step, recruitResult, pollStatus]);

  const displaySteps: DisplayStep[] = railOrder.map((state) => {
    const be = beSteps?.find((s) => s.state === state);
    let status: RailStatus = be?.status ?? 'pending';
    if (state === 'config_copied' && status === 'pending') status = 'done'; // 번들 다운로드=STEP3 완주로 이미 완료
    // 유나 가디언 polish#2: onboarding 공용 라벨("설정 복사됨")은 채용 맥락과 안 맞아 이 상태만 로컬 오버라이드.
    const label = state === 'config_copied' ? t('railBundleDownloaded') : tOnboarding(RAIL_LABEL_KEY[state]);
    return { state, status, label, reason: be?.reason };
  });
  const verified = displaySteps.find((s) => s.state === 'verified')?.status === 'done';

  const handleVerify = async () => {
    if (!recruitResult) return;
    setVerifying(true);
    try {
      await fetch(`/api/agents/${recruitResult.agent_id}/verify-connection?transport=${recruitResult.default_transport}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => {});
      await pollStatus();
    } finally {
      setVerifying(false);
    }
  };

  const mcpConfigText = useMemo(
    () => (recruitResult ? JSON.stringify(recruitResult.mcp_config, null, 2) : ''),
    [recruitResult],
  );

  // story d82c1092: equip-skip은 3단계(직무·스코프·완료)만 쓴다 — STEP3을 "완료"로 재라벨.
  const stages: { n: Step; label: string }[] = equipSkip
    ? [
        { n: 1, label: t('stepRole') },
        { n: 2, label: t('stepScope') },
        { n: 3, label: t('stepComplete') },
      ]
    : [
        { n: 1, label: t('stepRole') },
        { n: 2, label: t('stepScope') },
        { n: 3, label: t('stepRuntime') },
        { n: 4, label: t('stepBundle') },
        { n: 5, label: t('stepVerify') },
      ];

  return (
    <div className="mx-auto flex max-w-2xl flex-1 flex-col gap-4 p-4">
      {showTopBar ? (
        <TopBarSlot title={<h1 className="flex items-center gap-2 text-sm font-medium"><IdCard className="h-4 w-4" aria-hidden />{t('title')}</h1>} />
      ) : null}
      {onExit ? (
        <button
          type="button"
          onClick={onExit}
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {tAgents('backToList')}
        </button>
      ) : null}

      <SectionCard>
        <SectionCardHeader>
          <StepperHeader step={step} stages={stages} />
        </SectionCardHeader>
        <SectionCardBody className="space-y-4">

          {/* ── STEP 1 : 직무 선택 ── */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-foreground">{t('roleQuestion')}</p>

              {/* equip-skip(story d82c1092·C3): 역할 없이 키만 발급 — 맨몸추가(AddAgentForm) 흡수. */}
              <button
                type="button"
                onClick={() => { setEquipSkip(true); setSelectedRoleSlug(null); }}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-xl border border-dashed p-3 text-left transition-colors',
                  equipSkip ? 'border-primary/60 bg-primary/5 ring-1 ring-primary/40' : 'border-border hover:border-primary/30',
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-bold text-foreground">{t('equipSkipCardTitle')}</p>
                  <p className="text-xs text-muted-foreground">{t('equipSkipCardBody')}</p>
                </div>
                {equipSkip
                  ? <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden />
                  : <Badge variant="chip" className="shrink-0 text-[10px]">{t('equipSkipBadge')}</Badge>}
              </button>

              {roleError ? (
                <div className="flex items-center gap-2">
                  <p className="text-sm text-destructive">{t('roleLoadError')}</p>
                  <Button variant="ghost" size="sm" onClick={() => void fetchRoleTemplates()}>{t('retry')}</Button>
                </div>
              ) : !roleTemplates ? (
                <p className="text-sm text-muted-foreground">{t('roleLoading')}</p>
              ) : (
                <>
                  {/* 선생님 피드백(2026-07-07, ~110직군): 플랫 리스트 탐색 불가 — 검색 + division 그루핑. */}
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <input
                      type="text"
                      value={roleQuery}
                      onChange={(e) => setRoleQuery(e.target.value)}
                      placeholder={t('roleSearchPlaceholder')}
                      className="w-full rounded-lg border border-border bg-card py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  {/* 다음 버튼이 긴 리스트 하단에 묻히지 않도록 리스트 자체를 bounded-height 스크롤로 격리 —
                      버튼은 이 영역 밖(항상 보임)에 위치. */}
                  <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-0.5">
                    {roleGroups.length === 0 ? (
                      <p className="py-6 text-center text-sm text-muted-foreground">{t('roleSearchEmpty')}</p>
                    ) : roleGroups.map((group) => (
                      <div key={group.label} className="space-y-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {group.roles.map((role) => {
                            const Icon = CATEGORY_ICON[role.category] ?? Briefcase;
                            const sel = role.slug === selectedRoleSlug;
                            return (
                              <button
                                key={role.id}
                                type="button"
                                onClick={() => { setSelectedRoleSlug(role.slug); setEquipSkip(false); }}
                                className={cn(
                                  'relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors',
                                  sel ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border hover:border-primary/30',
                                )}
                              >
                                {sel && <Check className="absolute right-2.5 top-2.5 h-4 w-4 text-primary" aria-hidden />}
                                <span className="flex items-center gap-2 text-sm font-bold text-foreground">
                                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                                  {role.name}
                                </span>
                                {role.description && <span className="text-xs leading-relaxed text-muted-foreground">{role.description}</span>}
                                <span className="flex flex-wrap gap-1 pt-0.5">
                                  {role.default_tool_groups.map((g) => (
                                    <span key={g} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                      {tAgents.has(`toolPermissions.groups.${g}`) ? tAgents(`toolPermissions.groups.${g}`) : g}
                                    </span>
                                  ))}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('roleGuide')}
              </p>
              <div className="flex justify-end border-t border-border pt-3">
                <Button
                  variant="hero"
                  disabled={!selectedRoleSlug && !equipSkip}
                  onClick={() => setStep(2)}
                >
                  {t('next')}
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP 2 : 스코프(story d82c1092·NEW·AddAgentForm scope UI 하베스트) ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">{t('scopeQuestion')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['org', 'projects'] as const).map((mode) => {
                    const selected = scopeMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setScopeMode(mode)}
                        className={cn(
                          'rounded-md border px-4 py-4 text-left transition',
                          selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-foreground">
                              {mode === 'org' ? tSettings('agentScopeAllProjects') : tSettings('agentScopeSpecificProjects')}
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {mode === 'org' ? tSettings('agentScopeAllProjectsBody') : tSettings('agentScopeSpecificProjectsBody')}
                            </p>
                          </div>
                          {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden /> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {scopeMode === 'projects' && !orgProjects ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[0, 1].map((i) => <Skeleton key={i} className="h-14 rounded-md" />)}
                  </div>
                ) : scopeMode === 'projects' ? (
                  <div className="grid max-h-56 gap-3 overflow-y-auto sm:grid-cols-2">
                    {(orgProjects ?? []).map((project) => {
                      const selected = scopeProjectIds.includes(project.id);
                      return (
                        <button
                          key={project.id}
                          type="button"
                          onClick={() => toggleScopeProject(project.id)}
                          className={cn(
                            'rounded-md border px-4 py-4 text-left transition',
                            selected ? 'border-primary/40 bg-primary/10' : 'border-border bg-muted/30 hover:bg-muted',
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                            {selected ? <CheckCircle2 className="size-5 shrink-0 text-primary" aria-hidden /> : null}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                    {tSettings('agentScopeAllProjectsHint', { count: orgProjects?.length ?? 0 })}
                  </div>
                )}

                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t('scopeStepGuide')}
                </p>
                <p className="text-xs text-muted-foreground">{tSettings('agentSeatCaption')}</p>
              </div>

              {equipSkip ? (
                <div className="space-y-3 rounded-xl border border-border bg-muted/20 p-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{tSettings('agentNameLabel')}</label>
                    <input
                      type="text"
                      value={equipName}
                      onChange={(e) => setEquipName(e.target.value)}
                      placeholder={tSettings('agentNamePlaceholder')}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{tSettings('agentRoleLabel')}</label>
                    <select
                      value={equipRole}
                      onChange={(e) => setEquipRole(e.target.value as 'member' | 'admin')}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <option value="member">{tSettings('agentRoleMember')}</option>
                      <option value="admin">{tSettings('agentRoleAdmin')}</option>
                    </select>
                  </div>
                  {equipError && <p className="text-xs text-destructive">{equipError}</p>}
                </div>
              ) : null}

              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(1)}><ChevronLeft className="h-4 w-4" />{t('back')}</Button>
                {equipSkip ? (
                  <Button
                    variant="hero"
                    disabled={equipCreating || (scopeMode === 'projects' && scopeProjectIds.length === 0)}
                    onClick={() => void handleEquipCreate()}
                  >
                    {equipCreating ? t('equipCreating') : t('equipCreateCta')}
                  </Button>
                ) : (
                  <Button
                    variant="hero"
                    disabled={scopeMode === 'projects' && scopeProjectIds.length === 0}
                    onClick={() => setStep(3)}
                  >
                    {t('next')}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 3(Full 경로) : 실행환경 + 에이전트(G1) ── */}
          {step === 3 && !equipSkip && (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">{t('runtimeQuestion')}</p>
                {!runtimeCapabilities ? (
                  <div className="space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('runtimeSupportedLabel')}</p>
                    <div className="grid grid-cols-3 gap-2">
                      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
                    </div>
                  </div>
                ) : runtimeCapabilitiesError ? (
                  <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
                    <p className="text-sm font-medium text-foreground">{t('runtimeLoadError')}</p>
                    <p className="text-xs text-muted-foreground">{t('runtimeLoadErrorNote')}</p>
                    <Button variant="ghost" size="sm" onClick={() => void fetchRuntimeCapabilities()}>{t('retry')}</Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('runtimeSupportedLabel')}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {supportedRuntimes.map((rc) => {
                          const sel = runtime === rc.slug;
                          return (
                            <button
                              key={rc.slug}
                              type="button"
                              onClick={() => setRuntime(rc.slug)}
                              className={cn(
                                'relative flex flex-col items-start gap-1 rounded-xl border p-2.5 text-left transition-colors',
                                sel ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border hover:border-primary/30',
                              )}
                            >
                              {sel && <Check className="absolute right-2 top-2 h-3.5 w-3.5 text-primary" aria-hidden />}
                              <span className={cn(
                                'flex h-6 w-6 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground',
                                sel && 'bg-primary/15 text-primary',
                              )}>
                                {rc.icon ?? rc.display_name.charAt(0).toUpperCase()}
                              </span>
                              <span className="text-xs font-bold text-foreground">{rc.display_name}</span>
                              {rc.tier === 'experimental' && <Badge variant="info" className="text-[9px]">{t('runtimeExperimental')}</Badge>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {/* 지원 예정(레지스트리 supported=false) — dimmed·disabled */}
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('runtimeComingSoonLabel')}</p>
                      <div className="grid grid-cols-3 gap-2">
                        {comingSoonRuntimes.map((rc) => (
                          <button key={rc.slug} type="button" disabled className="flex cursor-not-allowed flex-col items-start gap-1 rounded-xl border border-border bg-muted/40 p-2.5 text-left opacity-55">
                            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground">
                              {rc.icon ?? rc.display_name.charAt(0).toUpperCase()}
                            </span>
                            <span className="text-xs font-bold text-foreground">{rc.display_name}</span>
                            <Badge variant="chip" className="text-[9px]">{t('runtimeComingSoonBadge')}</Badge>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t('runtimeGuide')}
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-semibold text-foreground">{t('agentQuestion')}</p>
                <div className="space-y-2.5 rounded-xl border border-info-border bg-info-tint/40 p-3">
                  <div className="flex w-fit rounded-lg border border-border bg-muted p-[3px]">
                    <button
                      type="button"
                      onClick={() => setAgentMode('new')}
                      className={cn('rounded px-2.5 py-1 text-xs font-semibold', agentMode === 'new' && 'bg-background text-foreground shadow-sm', agentMode !== 'new' && 'text-muted-foreground')}
                    >
                      {t('agentModeNew')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAgentMode('existing')}
                      className={cn('rounded px-2.5 py-1 text-xs font-semibold', agentMode === 'existing' && 'bg-background text-foreground shadow-sm', agentMode !== 'existing' && 'text-muted-foreground')}
                    >
                      {t('agentModeExisting')}
                    </button>
                  </div>
                  {agentMode === 'new' ? (
                    <input
                      type="text"
                      value={newAgentName}
                      onChange={(e) => setNewAgentName(e.target.value)}
                      placeholder={suggestedAgentName || t('agentNamePlaceholder')}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  ) : (
                    <select
                      value={selectedExistingAgentId}
                      onChange={(e) => setSelectedExistingAgentId(e.target.value)}
                      className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <option value="">{t('agentSelectPlaceholder')}</option>
                      {(existingAgents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                  <p className="flex items-start gap-1.5 text-xs text-info">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {t('agentInlineNote')}
                  </p>
                </div>
              </div>

              {recruitError && <p className="text-sm text-destructive">{recruitError}</p>}

              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(2)}><ChevronLeft className="h-4 w-4" />{t('back')}</Button>
                <Button variant="hero" disabled={recruiting} onClick={() => void handleRecruit()}>
                  {recruiting ? t('recruiting') : t('recruitCta')}
                </Button>
              </div>
            </div>
          )}

          {/* ── equip-skip 결과(story d82c1092·STEP3 재사용) — AddAgentForm 2-phase 결과 UX 그대로 ── */}
          {step === 3 && equipSkip && equipResult && (
            <div className="space-y-4">
              <div className="space-y-3 rounded-md border border-success-border bg-success-tint p-4">
                <p className="text-sm font-semibold text-success">{equipResult.name} 생성 완료</p>
                {equipResult.fakechat_port ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge variant="info">SSE</Badge>
                    <span className="font-mono text-foreground">Port: {equipResult.fakechat_port}</span>
                    <span className="text-muted-foreground">— fakechat http://localhost:{equipResult.fakechat_port}/sse</span>
                  </div>
                ) : null}
                {equipResult.api_key ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">API Key — 지금만 표시됩니다.</p>
                    <code className="block break-all rounded border border-border bg-background p-2 font-mono text-xs text-foreground/80">
                      {equipResult.api_key}
                    </code>
                  </div>
                ) : null}
                {equipResult.mcp_config ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-foreground">MCP Config</p>
                      <Button variant="glass" size="sm" onClick={() => void handleCopyEquipMcp()}>
                        {equipMcpCopied ? <><Check className="size-3" />{t('copied')}</> : <>{t('copy')}</>}
                      </Button>
                    </div>
                    <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-xs text-foreground/80">
                      {JSON.stringify(equipResult.mcp_config, null, 2)}
                    </pre>
                  </div>
                ) : null}
              </div>
              <div className="flex justify-end">
                <Button variant="hero" onClick={() => onExit?.()}>{t('equipDone')}</Button>
              </div>
            </div>
          )}

          {/* ── STEP 4 : 번들 프리뷰(파일 3종) ── */}
          {step === 4 && recruitResult && selectedRole && (
            <div className="space-y-4">
              <Alert variant="warning">
                <AlertDescription className="flex items-start gap-2">
                  <span aria-hidden>🔑</span>
                  <span><b>{t('keyOnceTitle')}</b> {recruitResult.mcp_config ? t('keyOnceBody') : t('keyOnceBodyNoMcp')}</span>
                </AlertDescription>
              </Alert>

              <div className="overflow-hidden rounded-md border border-border">
                <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
                  <span className="font-mono text-xs text-foreground">📄 {guideFilename} <span className="text-muted-foreground">{t('guideFileNote')}</span></span>
                  <CopyDownloadButtons content={recruitResult.system_prompt} filename={guideFilename} copied={copiedGuide} onCopied={() => setCopiedGuide(true)} />
                </div>
                <pre className="max-h-64 overflow-auto bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap">{recruitResult.system_prompt}</pre>
              </div>

              {recruitResult.mcp_config ? (
                <div className="overflow-hidden rounded-md border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
                    <span className="font-mono text-xs text-foreground">📄 .mcp.json <span className="text-muted-foreground">{t('mcpFileNote')}</span></span>
                    <CopyDownloadButtons content={mcpConfigText} filename=".mcp.json" copied={copiedMcp} onCopied={() => setCopiedMcp(true)} />
                  </div>
                  <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed">{mcpConfigText}</pre>
                </div>
              ) : (
                // 커넥터-라우팅 런타임(connector/grok/pi/hermes/openclaw/opencode)은 mcp_config=null —
                // MCP transport가 없어 .mcp.json 자체가 무의미. 문자열 "null" 렌더/복사 방지(story 6f6ac081 후속).
                <div className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  {t('mcpNotApplicable')}
                </div>
              )}

              <div className="space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">🔑 {t('scopeTitle')}</span>
                  <Button variant="ghost" size="sm" onClick={() => setShowRotateConfirm(true)}>
                    <RefreshCw className="h-3.5 w-3.5" />{t('rotate')}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="success">{t('scopeCore')}</Badge>
                  {recruitResult.tool_allowlist.map((g) => (
                    <span key={g} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {tAgents.has(`toolPermissions.groups.${g}`) ? tAgents(`toolPermissions.groups.${g}`) : g}
                    </span>
                  ))}
                  <span className="text-muted-foreground">{t('scopeCoreNote')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="destructive">{t('scopeBlocked')}</Badge>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground line-through opacity-60">admin</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground line-through opacity-60">destructive</span>
                  <span className="text-destructive">{t('scopeBlockedNote')}</span>
                </div>

                {showRotateConfirm && (
                  <div className="space-y-2 rounded-md border border-warning-border bg-warning-tint p-3">
                    <p className="text-xs font-semibold text-foreground">{t('rotateConfirmTitle')}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground"><b className="text-foreground">{t('rotateConfirmBold')}</b> {t('rotateConfirmBody')}</p>
                    {rotateError && <p className="text-xs text-destructive">{rotateError}</p>}
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setShowRotateConfirm(false)} disabled={rotating}>{t('cancel')}</Button>
                      <Button size="sm" className="bg-warning text-foreground hover:bg-warning/90" disabled={rotating} onClick={() => void handleRotateConfirmed()}>
                        {rotating ? t('rotating') : t('rotateConfirmCta')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('runtimeFilenameNote')}
              </p>

              <div className="flex justify-end pt-2">
                <Button variant="hero" onClick={() => setStep(5)}>{t('next')}</Button>
              </div>
            </div>
          )}

          {/* ── STEP 5 : 검증 + 배치(G5) ── */}
          {step === 5 && recruitResult && (
            <div className="space-y-4">
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('verifyGuide')}
              </p>

              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t('verifyTitle')}{' '}
                  <span className={cn('text-xs font-normal', recruitResult.default_transport === 'http' ? 'text-info' : 'text-muted-foreground')}>
                    {recruitResult.default_transport === 'http' ? tOnboarding('railStageHosted') : ''}
                  </span>
                </p>
                <Button variant="ghost" size="sm" onClick={() => void handleVerify()} disabled={verifying}>
                  <RefreshCw className={cn('h-3.5 w-3.5', verifying && 'animate-spin')} />{t('verifyRetry')}
                </Button>
              </div>
              <VerifyRail steps={displaySteps} />

              <div className="flex items-center gap-3 rounded-md border border-success/20 bg-success/10 p-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                  {activeAgentName.slice(0, 1) || '🪪'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-bold text-foreground">
                    {activeAgentName || t('deployedAgentFallback')}
                    <Badge variant="success">{t('deployedMember')}</Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">{selectedRole?.name} · {t('deployedNote')}</p>
                </div>
                <Link href="/board" className="shrink-0 text-xs font-semibold text-primary hover:underline">{t('viewInBoard')} →</Link>
              </div>

              <p className="flex items-start gap-1.5 text-xs text-info">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {t('executionBoundaryNote')}
              </p>

              <div className="flex justify-between gap-2 pt-2">
                <Button variant="ghost" onClick={() => setStep(4)}><ChevronLeft className="h-4 w-4" />{t('back')}</Button>
                <Link href="/dashboard"><Button variant={verified ? 'hero' : 'glass'}>{t('finish')}</Button></Link>
              </div>
            </div>
          )}
        </SectionCardBody>
      </SectionCard>
    </div>
  );
}
