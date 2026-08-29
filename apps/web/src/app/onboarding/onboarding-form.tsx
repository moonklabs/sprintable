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
  // story #2441 — #2437 실측: "Email verification required to create organization" 평문 영문
  // 에러에 막혀 다음 행동 안내(재전송·메일함 확認)가 0이라 완주 불가했다. verify 게이트 자체는
  // 그대로 두고(선생님 확認), 이 상태에 걸렸을 때만 "막다른 UX"를 정직하게 안내로 바꾼다.
  const [emailVerifyBlocked, setEmailVerifyBlocked] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendError, setResendError] = useState('');

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
    setEmailVerifyBlocked(false);
    setResendState('idle');
    setResendError('');

    // story #2000: 아래 fetch/json 파싱이 네트워크 단에서 throw하면(오프라인 등) try 없이는
    // setLoading(false)가 영영 안 불려 폼이 영구 로딩으로 멈춘다(온보딩 진입 자체를 막는 심각한
    // 케이스) — try/catch/finally로 봉합, 기존 error 상태를 그대로 재사용.
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName.trim(), slug: orgSlug.trim() }),
      });
      const json = await res.json();

      if (!res.ok) {
        // story #2441 — code로 분기(문자열 매칭은 반창고: 이 문구를 한국어로 바꾸는 판이라
        // 영문 매칭은 곧 깨진다). 이 케이스만 별도 UI(재전송+메일함 안내)로 갈아탄다 — 게이트
        // 자체는 BE가 그대로 지킨다(요구 완화 아님).
        if (json?.error?.code === 'EMAIL_VERIFICATION_REQUIRED') {
          setEmailVerifyBlocked(true);
          setError(t('emailVerifyRequiredError'));
          return;
        }
        // story #2470 — #2441과 같은 클래스: BE는 이미 구조화 에러(code:PLAN_LIMIT_EXCEEDED·
        // limit·upgrade_required)를 주는데 이전엔 여기서 raw 영문 message를 그대로 찍었다
        // ("Free plan org limit (1) reached. Upgrade to Team or Pro."). upgrade_required가
        // 있으면 UpgradeModal(이미 존재·다른 한도 케이스에서 재사용 중인 컴포넌트)로 안내한다 —
        // showUpgrade/upgradeReason state는 이 스토리 前엔 세팅부가 없어 죽어있던 자리였다.
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED' && json?.error?.upgrade_required) {
          setUpgradeReason(t('orgLimitExceededError', { limit: json.error.limit ?? 1 }));
          setShowUpgrade(true);
          return;
        }
        // story #2484 — 유나 design:changes(2026-08-06): 위 두 code는 분기하지만 그 «외»
        // code는 raw 서버 message가 그대로 샜다(형제 3핸들러(resend/create-project/
        // create-agent)만 고치고 이 자리를 놓친 것 — 가드도 위에 .code 토큰이 있어 못 잡는
        // 사각이었다). 알려지지 않은 code는 다른 핸들러와 동일하게 generic 폴백만 쓴다.
        setError(t('createOrgFailed'));
        return;
      }

      setOrgId(json.data.id);
      // E-ONB S5 FINAL: org 생성 시 org_member가 최초 생성됨 → 즉시 토큰 refresh로
      // 새 JWT에 org_id(BE auth Path4 org_member fallback) 반영. 이래야 다음 단계 project 생성의
      // getAuthContext(/api/v2/me)가 통과한다(미refresh 시 fresh JWT엔 team_member 없어 me null → 401).
      await fetch('/api/auth/refresh', { method: 'POST' }).catch(() => null);
      setStep('project');
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  };

  // story #2441 — BE `/auth/resend-verification`(auth.py, 3/hour rate-limit)의 BFF 프록시만
  // 새로 만들고, 여기서는 그 결과를 안내로 보여준다. 연타 방지는 BE 429가 최종 권위지만,
  // sending 동안 버튼을 비활성화해 화면단에서도 헛클릭을 막는다.
  const handleResendVerification = async () => {
    setResendState('sending');
    setResendError('');
    try {
      const res = await fetch('/api/auth/resend-verification', { method: 'POST' });
      const json = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      if (res.status === 429) {
        setResendState('error');
        setResendError(t('resendRateLimited'));
        return;
      }
      if (!res.ok) {
        // story #2484 — code로 분기(backend auth.py resend_verification()이 _err()로
        // 직접 발급하는 안정 값). 알려지지 않은 code만 안전 폴백.
        setResendState('error');
        if (json?.error?.code === 'USER_NOT_FOUND') {
          setResendError(t('resendUserNotFound'));
        } else {
          setResendError(t('resendFailed'));
        }
        return;
      }
      setResendState('sent');
    } catch {
      setResendState('error');
      setResendError(t('resendFailed'));
    }
  };

  // E-ONB S5: 온보딩 완료 후 홈(chat, story #3179 S3c) 이동 전 토큰 refresh.
  // register JWT는 app_metadata 비어(org_id 없음) — TeamMember는 project 생성 시 최초 생기므로,
  // 그 후 refresh로 새 JWT(sp_at)에 org_id 반영해야 보드/스토리 등 앱 전반 API가 차단되지 않는다.
  const finishToHome = async () => {
    await fetch('/api/auth/refresh', { method: 'POST' }).catch(() => null);
    window.location.href = '/chats';
  };

  const handleCreateProject = async () => {
    if (!projectName.trim() || !orgId) return;
    setLoading(true);
    setError('');

    try {
      // E-ONB S5 FINAL: org 생성 직후 refresh(handleCreateOrg)로 JWT에 org_id 반영됨 → X-Org-Id 불요(제거).
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, name: projectName.trim(), description: projectDesc.trim() || null }),
      });
      const json = await res.json();

      if (!res.ok) {
        // story #2484 — 실측(#2484 그라운딩): 이 분기는 'UPGRADE_REQUIRED'를 봤으나 backend
        // projects.py create_project()는 그 코드를 절대 내지 않는다(존재하지 않는 문자열이라
        // FastAPI 어디에도 없음 grep 확認) — organizations.py의 PLAN_LIMIT_EXCEEDED와 정확히
        // 같은 클래스(resource:"project")를 실제로 낸다. 그래서 이 UpgradeModal 경로는 지금껏
        // 한 번도 안 탄 죽은 분기였다(항상 아래 raw fallback으로 샜음). 코드를 바로잡는다.
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED') {
          setUpgradeReason(t('projectLimitExceededError', { limit: json.error.limit ?? 1 }));
          setShowUpgrade(true);
          return;
        }
        // 그 외(400 Invalid slug format·409 Slug already exists 등 — 온보딩은 explicit slug를
        // 안 보내 실질 도달 희박하나 방어적으로) code만 보고 raw message는 안 씀.
        setError(t('createProjectFailed'));
        return;
      }

      const project = json.data;
      if (!project) {
        setError(t('createProjectFailed'));
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
        await finishToHome();
        return;
      }
      setStep('agent');
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAgent = async () => {
    if (!agentName.trim() || !projectId || !orgId) return;
    setLoading(true);
    setError('');

    try {
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
      const memberJson = await memberRes.json() as { data?: { id: string; api_key?: string }; error?: { code?: string; message?: string } };
      // story #2484 — 이 정확한 호출 형태(온보딩·human 호출자·user_id 없음)에서 도달 가능한
      // 고유 code가 없어(그라운딩 확認) raw message 대신 통일된 안전 폴백만 사용.
      if (!memberRes.ok) {
        setError(t('createAgentFailed'));
        return;
      }

      const newAgentId = memberJson.data?.id;
      if (!newAgentId) {
        setError(t('createAgentFailed'));
        return;
      }
      setAgentId(newAgentId);

      // 에이전트 생성 응답에 이미 plaintext api_key가 포함됨(BE team_members.py: type=agent 생성 시 항상 발급).
      // 별도 발급 호출(POST /api/agents/{id}/api-key)은 BE가 body 필수라 빈 본문 시 422 → 응답 키를 그대로 사용.
      if (memberJson.data?.api_key) {
        setNewApiKey(memberJson.data.api_key);
      }

      setStep('connect');
    } catch {
      setError(t('networkError'));
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = () => {
    void finishToHome();
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
          // story #2105 2차 — handleCreateOrg/handleCreateProject/handleCreateAgent 모두 재시도 전
          // setError('')를 먼저 호출해(위 정의) 매 시도마다 언마운트→리마운트된다.
          <div role="alert" aria-live="assertive" aria-atomic="true" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-foreground">
            {error}
          </div>
        )}

        {/* story #2441 — #2437 실측: 이 게이트에서 다음 행동 안내가 0이라 완주 불가했다. 게이트
            자체(요구)는 안 건드리고, "막다른 UX"만 재전송+메일함 안내로 닫는다. */}
        {emailVerifyBlocked && (
          <div className="space-y-3 rounded-lg border border-border p-3 text-sm">
            <p className="text-foreground">{t('emailVerifyGuidance')}</p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleResendVerification()}
                disabled={resendState === 'sending'}
              >
                {resendState === 'sending' ? t('resending') : t('resendVerificationCta')}
              </Button>
              {resendState === 'sent' && (
                <span role="status" aria-live="polite" className="text-xs text-success">{t('resendSent')}</span>
              )}
              {resendState === 'error' && (
                <span role="alert" aria-live="assertive" className="text-xs text-destructive">{resendError}</span>
              )}
            </div>
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
                // ⚠️Phase2 i18n·#2485 — 클라 측 정규식 검증 문구가 하드코딩 한국어다(t() 아님,
                // 서버 응답과 무관 — raw 서버 누수는 아님). #2484 스코프 밖, 유나 design 확認.
                <p className="text-xs text-destructive">영소문자, 숫자, 하이픈만 사용 가능합니다</p>
              ) : !orgSlug && orgName.trim() ? (
                // story #2750 — 조직명이 한글 등 비-ASCII로만 이뤄지면 handleOrgNameChange의
                // 자동 파생(로마자/숫자만 남기는 정규식)이 전부 걸러내 orgSlug가 빈 문자열로
                // 남는다. 그 상태에서 아래 버튼이 무설명 disabled로 남던 것이 이 스토리의 근본
                // 결함 — 이미 존재하는 수동 slug 입력 칸(바로 위)으로 안내해 막힘을 뚫는다.
                <p className="text-xs text-destructive">{t('slugManualRequired')}</p>
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
          <ConnectStep agentId={agentId} apiKey={newApiKey} projectId={projectId} onFinish={handleFinish} />
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
