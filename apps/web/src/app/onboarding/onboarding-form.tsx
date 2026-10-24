'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { OperatorInput, OperatorTextarea, OperatorSelect } from '@/components/ui/operator-control';
import { useTranslations } from 'next-intl';
import { fetchWithAuth, refreshAuthTokens } from '@/lib/db/client';
import { defaultOrgName } from '@/lib/default-org-name';
import { fetchMyInvites, type MyInvite } from '@/lib/my-invites';
import { InvitedCard } from '@/components/desktop/desktop-setup';
import { ConnectStep } from './connect-step';
import { FirstScreen } from './first-screen';
import { existingOrgIdFromMe } from './existing-org';
import { emitOnboardingEvent } from './onboarding-telemetry';
import { withProjectParam } from '@/hooks/use-flat-href';
import { resolveOnboardingLandingHref } from '@/lib/onboarding-landing-href';

const AGENT_ROLES = ['developer', 'designer', 'pm', 'qa', 'devops'];
// story #3196 ⑥ — 값(BE role 필드, 영문 enum 그대로 무변경)과 표시 라벨을 분리. 예전엔
// AGENT_ROLES를 <option> 라벨로도 그대로 썼어(value===label) 한국어 온보딩 흐름 한복판에
// "developer" 등 영문이 그대로 노출됐다.
const AGENT_ROLE_LABEL_KEYS: Record<string, string> = {
  developer: 'roleDeveloper',
  designer: 'roleDesigner',
  pm: 'rolePm',
  qa: 'roleQa',
  devops: 'roleDevops',
};

// story 4715 (UX-1 · plan yuna/4715-plan-1016.md): no organization-name step and no fork. On arrival the page finds the person's
// organization, or their pending invites, or makes the organization with a made name («{name}의 조직» / «내 조직»), then shows ONE
// screen («first»: on a Mac [Mac 앱 받기] · elsewhere «지금은 Mac 앱만 있어요»). The web way (an agent already running somewhere else)
// keeps project → agent → connect.
/** story 4763 (H6 · codex): the press has been made — the `?after=org-deleted` of the address goes, so a reload is the usual onboarding */
function forgetOrgDeletedMarker() {
  try { window.history.replaceState(window.history.state, '', window.location.pathname); } catch { /* an address that cannot be changed stays */ }
}

type Step = 'arrive' | 'invited' | 'first' | 'project' | 'agent' | 'connect' | 'deleted';

/** The progress strip: only the web way's three steps have one (1/3 · 2/3 · 3/3) — arrival, invites and the one screen have none. */
export function onboardingProgress(step: Step): { fraction: number; label: { current: number; total: number } } | null {
  switch (step) {
    case 'project': return { fraction: 1 / 3, label: { current: 1, total: 3 } };
    case 'agent': return { fraction: 2 / 3, label: { current: 2, total: 3 } };
    case 'connect': return { fraction: 1, label: { current: 3, total: 3 } };
    default: return null;
  }
}

interface OnboardingFormProps {
  initialStep?: Step;
  initialOrgId?: string;
  // story #3983(PO 확定 2026-09-17 01:41Z) — 끝 착지: ON이면 todayHref·OFF면 chatsHref.
  // 서버(page.tsx)가 내려준다(이 컴포넌트는 'use client'라 직접 못 읽음). 기본값
  // false = 기존 테스트(이 prop 없이 마운트)가 계속 현행 착지를 기대.
  todayV3Enabled?: boolean;
  // story #4017 착지 뒤 재정정(2026-09-22) — resolveNavV3Destinations(flags).today.path를
  // 부모가 구해 내려준다(하드코딩 '/today' 0, chatsHref와 동형 필수 prop).
  todayHref: string;
  // story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:44Z/15:56Z) — 이 컴포넌트는
  // client라 process.env를 못 읽는다. 부모 page.tsx(서버)가
  // resolveChatsHref(readNavV3FlagsFromEnv())로 구해 prop으로 내려준다. 필수로 둬서
  // (기본값 없음) 호출부가 빠뜨리면 타입 에러로 즉시 걸린다 — 가드 예외(리터럴 기본값)도
  // 이걸로 사라진다.
  chatsHref: string;
  /** story 4714 AC2: resolved by the server page (`isDesktopDownloadEnabled`) — whether the phone app's first screen offers «메일로 받기» */
  macDownloadEnabled?: boolean;
  /** story 4763 (H6): the person was sent here by deleting their organization — they are told, and the new one is made on their press (never silently, with the same name) */
  afterOrgDelete?: boolean;
}

/** What arrival is doing: working on it · stopped because the invites could not be read (nothing made) · stopped on another failure */
type Arrival = 'working' | 'account-check-failed' | 'invite-check-failed' | 'failed';

export function OnboardingForm({
  initialStep, initialOrgId, todayV3Enabled = false, todayHref, chatsHref, macDownloadEnabled = false, afterOrgDelete = false,
}: OnboardingFormProps) {
  const t = useTranslations('onboarding');
  const tc = useTranslations('common');
  const tNewOrg = useTranslations('desktopOnboarding');

  const [step, setStep] = useState<Step>(initialStep ?? (afterOrgDelete ? 'deleted' : 'arrive'));
  const [arrival, setArrival] = useState<Arrival>('working');
  const [invites, setInvites] = useState<MyInvite[]>([]);
  // the organization's name when this page made it — shown on the one screen; null when not known here (never made up)
  const [orgName, setOrgName] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [projectDesc, setProjectDesc] = useState('');
  const [orgId, setOrgId] = useState<string | null>(initialOrgId ?? null);
  const [projectId, setProjectId] = useState<string | null>(null);
  // story #3196 ⑥ — 하드코딩 영문 기본값 제거. 빈 값으로 두면 이미 로컬라이즈돼 있던
  // agentNamePlaceholder(t('agentNamePlaceholder'))가 정상 노출된다(placeholder는 value가
  // 있으면 안 보이는 표준 동작이라, value 자체를 채워두면 placeholder 번역이 무의미해짐).
  const [agentName, setAgentName] = useState('');
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
  // one arrival at a time — a second run (a remount in development · a double press) must never make a second organization
  const arriving = useRef(false);
  // the person's choice «초대와 따로 내 조직 만들기» — kept across the arrival's retries (a retry never asks the invites again)
  const ownOrgChosen = useRef(false);

  const progress = onboardingProgress(step);

  // story 4763 (codex): the session is renewed by ONE call at a time — the refresh token rotates on use, so the deleted screen's own renewal and the press's (or a double press) must share the
  // call in flight, not race it. `refreshAuthTokens` answers `{data, error}` instead of throwing: a missing `data` is not a success either. NO_REFRESH_TOKEN = nothing to renew.
  const renewing = useRef<Promise<'renewed' | 'nothing-to-renew' | 'failed'> | null>(null);
  const renewSession = () => {
    if (!renewing.current) {
      renewing.current = refreshAuthTokens()
        .then((r): 'renewed' | 'nothing-to-renew' | 'failed' => (!r ? 'failed' : r.error ? (r.error.code === 'NO_REFRESH_TOKEN' ? 'nothing-to-renew' : 'failed') : r.data ? 'renewed' : 'failed'), () => 'failed' as const)
        .finally(() => { renewing.current = null; });
    }
    return renewing.current;
  };

  // OB-4: wizard 진입 1회 emit. session_id는 telemetry가 sessionStorage로 1회차당 고정.
  useEffect(() => {
    emitOnboardingEvent('onboarding_started');
  }, []);

  // story 4715 (AC1 · AC6): the organization is never asked for — make it with a made name, but only once the invites are known to be none
  const createOrg = async (name: string) => {
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // story 4669: no slug — the server derives it from the name (ASCII part, or `workspace-<8 hex>` for a Korean-only name)
        body: JSON.stringify({ name }),
      });
      const json = await res.json();

      if (!res.ok) {
        // story #2441 — code로 분기(문자열 매칭은 반창고). 이 케이스만 별도 UI(재전송+메일함 안내)로 갈아탄다.
        if (json?.error?.code === 'EMAIL_VERIFICATION_REQUIRED') {
          setEmailVerifyBlocked(true);
          setError(t('emailVerifyRequiredError'));
          setArrival('failed');
          return;
        }
        // story #2470 — BE의 구조화 에러(code:PLAN_LIMIT_EXCEEDED·limit·upgrade_required)는 UpgradeModal로 안내한다.
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED' && json?.error?.upgrade_required) {
          setUpgradeReason(t('orgLimitExceededError', { limit: json.error.limit ?? 1 }));
          setShowUpgrade(true);
          setArrival('failed');
          return;
        }
        // story #2484 — 알려지지 않은 code는 generic 폴백만(raw 서버 message 미노출).
        setError(t('createOrgFailed'));
        setArrival('failed');
        return;
      }

      setOrgId(json.data.id);
      setOrgName(name);
      // E-ONB S5 FINAL: org 생성 시 org_member가 최초 생성됨 → 즉시 토큰 refresh로
      // 새 JWT에 org_id(BE auth Path4 org_member fallback) 반영. 이래야 다음 단계 project 생성의
      // getAuthContext(/api/v2/me)가 통과한다(미refresh 시 fresh JWT엔 team_member 없어 me null → 401).
      // story 4762 — refreshAuthTokens(lib/db/client.ts)가 새로고침과 함께 셸에 «세션이 바뀌었다»(session-changed)도 알린다: 이 순간 앱이 꺼져도 org 클레임이 든
      // 새 토큰이 디스크에 남도록. 맨 fetch는 이 신호를 안 보냈다(폰 강제 종료 뒤 클레임 없는 옛 토큰이 남아 /glance가 404 — 실측 10-24).
      await refreshAuthTokens().catch(() => null);
      setStep('first');
    } catch {
      setError(t('networkError'));
      setArrival('failed');
    }
  };

  // story 4715: arrival. `ownOrg` — the person chose «초대와 따로 내 조직 만들기» on the invited screen: the invites are known, make it.
  const arrive = async (ownOrg = ownOrgChosen.current) => {
    if (arriving.current) return;
    arriving.current = true;
    ownOrgChosen.current = ownOrg;
    // from the invited card the arrival's own screen takes over, so a failed read there is seen (with its retry), not hidden behind the card
    if (ownOrg) setStep('arrive');
    // from the invited card the arrival's own screen takes over, so a failed read there is seen (with its retry), not hidden behind the card
    setArrival('working');
    setError('');
    setEmailVerifyBlocked(false);
    setResendState('idle');
    setResendError('');
    try {
      // `/api/auth/me` answers from the JWT claims — 200 with or without an organization (story #3195 · 카디르 QA PR#3617)
      // rule 4832 for this read too (Kadir QA 5124): an answer that cannot be read is NOT «no organization» — folding it would make a second
      // organization for a person who already has one. Stop with [다시 확인]; nothing is made.
      let me: { data?: { member_id?: string | null; org_id?: string | null; org_member_id?: string | null; email_verified?: boolean | null; display_name?: string | null } } | null;
      try {
        const res = await fetchWithAuth('/api/auth/me');
        if (!res.ok) throw new Error(String(res.status));
        me = await res.json();
        // a 200 that carries no account (`{}` · `{data:null}` · `{data:{}}`) is not an answer either — the contract's account always has
        // `member_id` (backend AuthMeResponse), so only that counts as «read»
        if (typeof me?.data?.member_id !== 'string' || !me.data.member_id) throw new Error('no account');
      } catch {
        setArrival('account-check-failed');
        return;
      }
      let existing = existingOrgIdFromMe(me);
      if (!existing) {
        // story 4763 (AC11): `/api/auth/me` answers from the session's TOKEN — one made before the organization existed (a sign-up on the web, then the Mac app's login;
        // the web tab's own arrival made the organization meanwhile) carries no organization although the person has one, and the second «조직 만들기» ended in
        // «무료 플랜은 조직을 1개까지» with no way out. A fresh token is read from the database: renew once, ask again, and only then decide there is none.
        // (the renewal also tells the shell the session changed, so the app's stored token carries the organization from here on — story 4762.)
        // a renewal that did not happen leaves the same old token, whose «no organization» is not an answer: nothing is made (Kadir lens on 5221). «Nothing to renew» (a session with no refresh
        // token — the phone's Firebase session reads its claims fresh every time) is not a failure: the second read below decides
        if ((await renewSession()) === 'failed') { setArrival('account-check-failed'); return; }
        try {
          const again = await fetchWithAuth('/api/auth/me');
          if (!again.ok) throw new Error(String(again.status));
          const againJson = await again.json();
          if (typeof againJson?.data?.member_id !== 'string' || !againJson.data.member_id) throw new Error('no account');
          me = againJson;
          existing = existingOrgIdFromMe(againJson);
        } catch {
          // rule 4832: the second read cannot be read — that is not «no organization» either; nothing is made
          setArrival('account-check-failed');
          return;
        }
      }
      // story 4668: already a member (a reload · a re-opened `/onboarding?signup=1`) — no second organization
      if (existing) { setOrgId(existing); setStep('first'); return; }
      // the e-mail gate normally stands before this page; if it is still unverified, say so and make nothing (story #2441)
      if (me?.data?.email_verified === false) { setEmailVerifyBlocked(true); setArrival('failed'); return; }
      if (!ownOrg) {
        let pending: MyInvite[];
        try {
          pending = await fetchMyInvites();
        } catch {
          // rule 4832: never make an organization while the invites are unknown
          setArrival('invite-check-failed');
          return;
        }
        if (pending.length > 0) { setInvites(pending); setStep('invited'); return; }
      }
      const name = defaultOrgName(me?.data?.display_name, (n) => tNewOrg('defaultOrgNameWithName', { name: n }), tNewOrg('defaultOrgName'));
      setStep('arrive');
      await createOrg(name);
    } finally {
      arriving.current = false;
    }
  };

  // story 4763 (H6 · codex): the deleted screen says «this account has no organization» — a reload or an old link after the new organization exists must not say it. It asks quietly who the person
  // is; one who already has an organization (the others of several, or the new one) goes on as in the arrival (a failed read keeps the screen: its press reads again before it makes anything)
  useEffect(() => {
    if (step !== 'deleted') return;
    let off = false;
    void (async () => {
      // the token the person holds was made before the delete (it still names that organization, and an account with others reads as «none» until it is renewed) — renew, then ask
      if ((await renewSession()) === 'failed') return; // not knowing is not «none», but it is not «has one» either: the screen stays and its press asks again before it makes anything
      const res = await fetchWithAuth('/api/auth/me');
      if (!res.ok) return;
      const existing = existingOrgIdFromMe(await res.json());
      if (existing && !off) { setOrgId(existing); setStep('first'); }
    })().catch(() => undefined);
    return () => { off = true; };
  }, [step]);

  useEffect(() => {
    if (step === 'arrive') void arrive();
    // arrival runs once, on mount; a retry is the person's press
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    await refreshAuthTokens().catch(() => null); // story 4762 — same: the shell writes the new token out now
    // story #4231 — 첫 착지(flat)는 방금 만든 프로젝트를 싣는다(착지 뒤 셸 ?p= 정규화 왕복 없음).
    window.location.href = withProjectParam(resolveOnboardingLandingHref(todayV3Enabled, todayHref, chatsHref), projectId);
  };

  const handleCreateProject = async () => {
    if (!projectName.trim() || !orgId) return;
    setLoading(true);
    setError('');

    try {
      // E-ONB S5 FINAL: org 생성 직후 refresh로 JWT에 org_id 반영됨 → X-Org-Id 불요(제거).
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, name: projectName.trim(), description: projectDesc.trim() || null }),
      });
      const json = await res.json();

      if (!res.ok) {
        // story #2484 — backend projects.py create_project()는 'PLAN_LIMIT_EXCEEDED'(resource:"project")를 낸다.
        if (json?.error?.code === 'PLAN_LIMIT_EXCEEDED') {
          setUpgradeReason(t('projectLimitExceededError', { limit: json.error.limit ?? 1 }));
          setShowUpgrade(true);
          return;
        }
        // 그 외 code만 보고 raw message는 안 씀.
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
      // story #2484 — 도달 가능한 고유 code가 없어 raw message 대신 통일된 안전 폴백만 사용.
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

  // story 4763 (H6): the only organization was just deleted — the screen says so; the new organization is made by this press (a second reading of invites included)
  if (step === 'deleted') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md space-y-4 p-6 text-center shadow-lg sm:p-8" data-testid="onboarding-org-deleted">
          <h1 className="text-base font-semibold">{t('orgDeletedTitle')}</h1>
          <p className="break-keep text-sm text-muted-foreground">{t('orgDeletedBody')}</p>
          <Button onClick={() => { forgetOrgDeletedMarker(); setStep('arrive'); void arrive(); }} data-testid="onboarding-org-deleted-new">{t('orgDeletedNew')}</Button>
        </Card>
      </div>
    );
  }

  // story 4715 (AC6): pending invites — the invited card (the app setup's own · its words), and one way to make an organization anyway
  if (step === 'invited') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-3" data-testid="onboarding-invited">
          <InvitedCard invites={invites} onReload={() => window.location.reload()} onCreateOwn={() => void arrive(true)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className={`w-full ${step === 'connect' ? 'max-w-lg' : 'max-w-md'} space-y-6 rounded-2xl border border-border bg-card p-6 shadow-lg sm:p-8`} data-testid="onboarding-card">
        {/* 진행 표시줄 — story 4715: the web way's three steps only */}
        {progress ? (
          <div className="space-y-1.5" data-testid="onboarding-progress">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span data-testid="onboarding-step-of">{t('stepOf', progress.label)}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted">
              <div
                className="h-1.5 rounded-full bg-primary transition-all duration-300"
                style={{ width: `${progress.fraction * 100}%` }}
                data-testid="onboarding-progress-bar"
              />
            </div>
          </div>
        ) : null}

        {step === 'project' || step === 'agent' || step === 'connect' ? (
          <div className="text-center">
            <h1 id="onboarding-step-title" className="break-keep text-2xl font-bold text-foreground">
              {step === 'project' && t('createProject')}
              {step === 'agent' && t('createAgent')}
              {step === 'connect' && t('connectAgent')}
            </h1>
            <p className="mt-2 break-keep text-sm text-muted-foreground">
              {step === 'project' && (orgName ? t('projectSubtitle', { orgName }) : t('projectSubtitleNoOrg'))}
              {step === 'agent' && t('agentSubtitle')}
              {step === 'connect' && t('connectSubtitle')}
            </p>
          </div>
        ) : null}

        {error && (
          // story #2105 2차 — 재시도 전 setError('')를 먼저 호출해 매 시도마다 언마운트→리마운트된다.
          <div role="alert" aria-live="assertive" aria-atomic="true" className="rounded-lg border border-destructive/20 bg-destructive-tint p-3 text-sm text-foreground">
            {error}
          </div>
        )}

        {/* story #2441 — 이 게이트에서 다음 행동 안내가 0이라 완주 불가했다. 게이트 자체(요구)는 안 건드리고,
            "막다른 UX"만 재전송+메일함 안내로 닫는다. */}
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

        {step === 'arrive' && (
          <div className="space-y-4 text-center" data-testid="onboarding-arrive">
            {arrival === 'working' ? (
              <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span id="onboarding-step-title">{t('arriving')}</span>
              </p>
            ) : arrival === 'account-check-failed' ? (
              <div className="space-y-3">
                <p role="alert" className="break-keep text-sm text-foreground" data-testid="onboarding-account-check-failed">{t('accountCheckFailed')}</p>
                <Button variant="outline" onClick={() => void arrive()} data-testid="onboarding-account-check-again">{t('inviteCheckAgain')}</Button>
              </div>
            ) : arrival === 'invite-check-failed' ? (
              <div className="space-y-3">
                <p role="alert" className="break-keep text-sm text-foreground" data-testid="onboarding-invite-check-failed">{t('inviteCheckFailed')}</p>
                <Button variant="outline" onClick={() => void arrive()} data-testid="onboarding-invite-check-again">{t('inviteCheckAgain')}</Button>
              </div>
            ) : (
              <Button variant="outline" onClick={() => void arrive()} data-testid="onboarding-arrive-retry">{tc('retry')}</Button>
            )}
          </div>
        )}

        {step === 'first' && (
          <FirstScreen orgId={orgId} chatsHref={chatsHref} macDownloadEnabled={macDownloadEnabled} orgName={orgName} todayV3Enabled={todayV3Enabled} onFinish={handleFinish} />
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
              {loading ? tc('creating') : t('createProjectAction')}
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
                  <option key={r} value={r}>{t(AGENT_ROLE_LABEL_KEYS[r] ?? r)}</option>
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
              {loading ? tc('creating') : t('createAgentAction')}
            </Button>
            {/* story 4668 (AC2): skipping goes to the connect step (the app card is there) — before, it went home: a dead end */}
            <Button
              variant="glass"
              size="lg"
              className="w-full"
              onClick={() => setStep('connect')}
            >
              {t('skip')}
            </Button>
          </div>
        )}

        {step === 'connect' && (
          <ConnectStep
            agentId={agentId}
            apiKey={newApiKey}
            projectId={projectId}
            orgId={orgId}
            onFinish={handleFinish}
            todayV3Enabled={todayV3Enabled}
            onMakeAgent={() => setStep('agent')}
          />
        )}
      </div>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
