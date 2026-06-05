'use client';

import { useState } from 'react';
import Link from 'next/link';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { Button } from '@/components/ui/button';
import { OperatorInput, OperatorTextarea, OperatorSelect } from '@/components/ui/operator-control';
import { useTranslations } from 'next-intl';

function getAppOrigin() {
  if (typeof window !== 'undefined') return window.location.origin;
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.sprintable.ai';
}
const MCP_SERVER_URL = () => `${getAppOrigin()}/api/v2/mcp`;
const LLMS_PROMPT = () => `Read this document and complete onboarding: ${getAppOrigin()}/llms.txt`;
const AGENT_ROLES = ['developer', 'designer', 'pm', 'qa', 'devops'];

function buildMcpConfig(apiKey: string) {
  return JSON.stringify(
    {
      mcpServers: {
        sprintable: {
          type: 'streamable-http',
          url: MCP_SERVER_URL(),
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      },
    },
    null,
    2,
  );
}

type Step = 'org' | 'project' | 'agent' | 'connect';
const STEPS: Step[] = ['org', 'project', 'agent', 'connect'];

interface OnboardingFormProps {
  initialStep?: Step;
  initialOrgId?: string;
}

export function OnboardingForm({ initialStep, initialOrgId }: OnboardingFormProps = {}) {
  const t = useTranslations('onboarding');

  const [step, setStep] = useState<Step>(initialStep ?? 'org');
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [orgId, setOrgId] = useState<string | null>(initialOrgId ?? null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState('My Agent');
  const [agentRole, setAgentRole] = useState('developer');
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const stepIndex = STEPS.indexOf(step);

  const handleOrgNameChange = (name: string) => {
    setOrgName(name);
    setOrgSlug(
      name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 50),
    );
  };

  const handleOrgSlugChange = (value: string) => {
    setOrgSlug(value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50));
  };

  const slugValid = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$|^[a-z0-9]$/.test(orgSlug);

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
  };

  const handleCreateOrg = async () => {
    if (!orgName.trim() || !orgSlug.trim()) return;
    setLoading(true);
    setError('');

    const res = await fetch('/api/organizations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: orgName.trim(), slug: orgSlug.trim() }),
    });
    const json = await res.json();

    if (!res.ok) {
      setError(json?.error?.message ?? t('createOrgFailed'));
      setLoading(false);
      return;
    }

    setOrgId(json.data.id);
    setStep('project');
    setLoading(false);
  };

  // E-ONB S5: 온보딩 완료 후 /dashboard 이동 전 토큰 refresh.
  // register JWT는 app_metadata 비어(org_id 없음) — TeamMember는 project 생성 시 최초 생기므로,
  // 그 후 refresh로 새 JWT(sp_at)에 org_id 반영해야 보드/스토리 등 앱 전반 API가 차단되지 않는다.
  const finishToDashboard = async () => {
    await fetch('/api/auth/refresh', { method: 'POST' }).catch(() => null);
    window.location.href = '/dashboard';
  };

  const handleCreateProject = async () => {
    if (!projectName.trim() || !orgId) return;
    setLoading(true);
    setError('');

    const res = await fetch('/api/projects', {
      method: 'POST',
      // E-ONB S5: 신규 register JWT는 app_metadata 비어(org_id 없음) → BE get_verified_org_id 401.
      // 방금 생성한 org.id를 X-Org-Id로 보내면 BE가 membership fallback 검증(proxyToFastapi가 x-org-id forward).
      headers: { 'Content-Type': 'application/json', 'X-Org-Id': orgId },
      body: JSON.stringify({ org_id: orgId, name: projectName.trim(), description: projectDesc.trim() || null }),
    });
    const json = await res.json();

    if (!res.ok) {
      if (json?.error?.code === 'UPGRADE_REQUIRED') {
        setUpgradeReason(json.error.message);
        setShowUpgrade(true);
        setLoading(false);
        return;
      }
      setError(json?.error?.message ?? t('createProjectFailed'));
      setLoading(false);
      return;
    }

    const project = json.data;
    if (!project) {
      setError(t('createProjectFailed'));
      setLoading(false);
      return;
    }

    setProjectId(project.id);

    // team_member 자동 생성 (type=human)
    const meRes = await fetch('/api/me');
    if (meRes.ok) {
      const meJson = await meRes.json() as { data?: { name?: string } };
      const memberName = meJson.data?.name ?? t('unknownUser');
      await fetch('/api/team-members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org_id: orgId,
          project_id: project.id,
          type: 'human',
          name: memberName,
          role: 'admin',
        }),
      }).catch(() => null);
    }

    await fetch('/api/current-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: project.id }),
    }).catch(() => null);

    if (initialStep === 'project') {
      await finishToDashboard();
      return;
    }
    setStep('agent');
    setLoading(false);
  };

  const handleCreateAgent = async () => {
    if (!agentName.trim() || !projectId || !orgId) return;
    setLoading(true);
    setError('');

    const memberRes = await fetch('/api/team-members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_id: orgId,
        project_id: projectId,
        type: 'agent',
        name: agentName.trim(),
        role: agentRole,
      }),
    });
    const memberJson = await memberRes.json() as { data?: { id: string }; error?: { message?: string } };
    if (!memberRes.ok) {
      setError(memberJson?.error?.message ?? 'Failed to create agent');
      setLoading(false);
      return;
    }

    const agentId = memberJson.data?.id;
    if (!agentId) {
      setError('Failed to create agent');
      setLoading(false);
      return;
    }

    const keyRes = await fetch(`/api/agents/${agentId}/api-key`, { method: 'POST' });
    const keyJson = await keyRes.json() as { data?: { api_key: string } };
    if (keyRes.ok && keyJson.data?.api_key) {
      setNewApiKey(keyJson.data.api_key);
    }

    setStep('connect');
    setLoading(false);
  };

  const handleFinish = () => {
    void finishToDashboard();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-8">
        {/* 진행 표시줄 */}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{t('stepOf', { current: stepIndex + 1, total: STEPS.length })}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold text-foreground">
            {step === 'org' && t('createOrg')}
            {step === 'project' && t('createProject')}
            {step === 'agent' && t('createAgent')}
            {step === 'connect' && t('connectAgent')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {step === 'org' && t('welcome')}
            {step === 'project' && t('projectSubtitle', { orgName })}
            {step === 'agent' && t('agentSubtitle')}
            {step === 'connect' && t('connectSubtitle')}
          </p>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === 'org' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('orgName')}</label>
              <OperatorInput
                type="text"
                value={orgName}
                onChange={(e) => handleOrgNameChange(e.target.value)}
                placeholder={t('orgNamePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('slug')}</label>
              <OperatorInput
                type="text"
                value={orgSlug}
                onChange={(e) => handleOrgSlugChange(e.target.value)}
                placeholder={t('slugPlaceholder')}
              />
              {orgSlug && !slugValid ? (
                <p className="text-xs text-destructive">영소문자, 숫자, 하이픈만 사용 가능합니다</p>
              ) : (
                <p className="text-xs text-muted-foreground">sprintable.app/{orgSlug || '...'}</p>
              )}
            </div>
            <Button
              variant="hero"
              size="lg"
              className="w-full"
              onClick={() => void handleCreateOrg()}
              disabled={!orgName.trim() || !orgSlug.trim() || !slugValid || loading}
            >
              {loading ? t('creating') : t('createOrg')}
            </Button>
          </div>
        )}

        {step === 'project' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('projectName')}</label>
              <OperatorInput
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t('projectNamePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('projectDesc')}</label>
              <OperatorTextarea
                value={projectDesc}
                onChange={(e) => setProjectDesc(e.target.value)}
                placeholder={t('projectDescPlaceholder')}
                rows={3}
              />
            </div>
            <Button
              variant="hero"
              size="lg"
              className="w-full"
              onClick={() => void handleCreateProject()}
              disabled={!projectName.trim() || loading}
            >
              {loading ? t('creating') : t('createProjectAction')}
            </Button>
          </div>
        )}

        {step === 'agent' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('agentName')}</label>
              <OperatorInput
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={t('agentNamePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">{t('agentRole')}</label>
              <OperatorSelect
                value={agentRole}
                onChange={(e) => setAgentRole(e.target.value)}
              >
                {AGENT_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </OperatorSelect>
            </div>
            <Button
              variant="hero"
              size="lg"
              className="w-full"
              onClick={() => void handleCreateAgent()}
              disabled={!agentName.trim() || loading}
            >
              {loading ? t('creating') : t('createAgentAction')}
            </Button>
            <Button
              variant="glass"
              size="lg"
              className="w-full"
              onClick={handleFinish}
            >
              {t('skip')}
            </Button>
          </div>
        )}

        {step === 'connect' && (
          <div className="space-y-4">
            {newApiKey ? (
              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-foreground">{t('mcpConfigTitle')}</p>
                  <button
                    type="button"
                    onClick={() => void handleCopy(buildMcpConfig(newApiKey), 'mcp')}
                    className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                  >
                    {copied === 'mcp' ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-2 text-xs text-foreground">
                  {buildMcpConfig(newApiKey)}
                </pre>
              </div>
            ) : (
              <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 space-y-2">
                <p className="text-sm text-amber-600 dark:text-amber-400">{t('apiKeyFailedMembers')}</p>
                <Link
                  href="/settings?tab=members"
                  className="inline-block rounded border border-amber-500/30 bg-background px-3 py-1 text-xs font-medium text-amber-600 hover:bg-amber-500/10 transition-colors dark:text-amber-400"
                >
                  {t('goToMembersAgents')} →
                </Link>
              </div>
            )}

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-foreground">{t('promptTitle')}</p>
                <button
                  type="button"
                  onClick={() => void handleCopy(LLMS_PROMPT(), 'prompt')}
                  className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
                >
                  {copied === 'prompt' ? '✓ Copied' : 'Copy'}
                </button>
              </div>
              <p className="break-all rounded-md border border-border bg-background p-2 text-xs text-foreground">
                {LLMS_PROMPT()}
              </p>
            </div>

            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              에이전트 추가 및 API Key 관리:{' '}
              <Link href="/settings?tab=members" className="font-medium text-primary hover:underline">
                Settings → Members → Agents
              </Link>
            </div>

            <Button
              variant="hero"
              size="lg"
              className="w-full"
              onClick={handleFinish}
            >
              {t('finish')}
            </Button>
          </div>
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
