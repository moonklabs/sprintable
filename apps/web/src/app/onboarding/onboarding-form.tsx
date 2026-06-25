'use client';

import { useEffect, useState } from 'react';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { Button } from '@/components/ui/button';
import { OperatorInput, OperatorTextarea, OperatorSelect } from '@/components/ui/operator-control';
import { useTranslations } from 'next-intl';
import { ConnectStep } from './connect-step';
import { emitOnboardingEvent } from './onboarding-telemetry';

const AGENT_ROLES = ['developer', 'designer', 'pm', 'qa', 'devops'];

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
  const [agentId, setAgentId] = useState<string | null>(null);
  const [newApiKey, setNewApiKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState('');

  const stepIndex = STEPS.indexOf(step);

  // OB-4: wizard 진입 1회 emit. session_id는 telemetry가 sessionStorage로 1회차당 고정.
  useEffect(() => {
    emitOnboardingEvent('onboarding_started');
  }, []);

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
    // E-ONB S5 FINAL: org 생성 시 org_member가 최초 생성됨 → 즉시 토큰 refresh로
    // 새 JWT에 org_id(BE auth Path4 org_member fallback) 반영. 이래야 다음 단계 project 생성의
    // getAuthContext(/api/v2/me)가 통과한다(미refresh 시 fresh JWT엔 team_member 없어 me null → 401).
    await fetch('/api/auth/refresh', { method: 'POST' }).catch(() => null);
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

    // E-ONB S5 FINAL: org 생성 직후 refresh(handleCreateOrg)로 JWT에 org_id 반영됨 → X-Org-Id 불요(제거).
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

    // 휴먼 members 앵커는 BE가 org/project 생성 시 ensure_human_member로 보장한다(#1317 휴먼판).
    // 과거 여기서 호출하던 /api/team-members(type=human) POST는 410 Gone(데드 경로)이라 제거.

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
    const memberJson = await memberRes.json() as { data?: { id: string; api_key?: string }; error?: { message?: string } };
    if (!memberRes.ok) {
      setError(memberJson?.error?.message ?? 'Failed to create agent');
      setLoading(false);
      return;
    }

    const newAgentId = memberJson.data?.id;
    if (!newAgentId) {
      setError('Failed to create agent');
      setLoading(false);
      return;
    }
    setAgentId(newAgentId);

    // 에이전트 생성 응답에 이미 plaintext api_key가 포함됨(BE team_members.py: type=agent 생성 시 항상 발급).
    // 별도 발급 호출(POST /api/agents/{id}/api-key)은 BE가 body 필수라 빈 본문 시 422 → 응답 키를 그대로 사용.
    if (memberJson.data?.api_key) {
      setNewApiKey(memberJson.data.api_key);
    }

    setStep('connect');
    setLoading(false);
  };

  const handleFinish = () => {
    void finishToDashboard();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className={`w-full ${step === 'connect' ? 'max-w-lg' : 'max-w-md'} space-y-6 rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-8`}>
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
          <ConnectStep agentId={agentId} apiKey={newApiKey} onFinish={handleFinish} />
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
