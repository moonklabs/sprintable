'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import { UpgradeModal } from '@/components/ui/upgrade-modal';
import { Card as LegacyCard } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ds/card';
import { Stepper, type StepperStep } from '@/components/ds/stepper';
import { useTranslations } from 'next-intl';
import { fetchWithAuth, logoutUser, refreshSessionAfterChange, refreshSessionOnce } from '@/lib/db/client';
import { Button as DsButton } from '@/components/ds/button';
import { DeleteAccountDialog } from '@/components/settings/delete-account-dialog';
import { defaultOrgName } from '@/lib/default-org-name';
import { fetchMyInvites, type MyInvite } from '@/lib/my-invites';
import { InvitedCard } from '@/components/desktop/desktop-setup';
import { FirstScreen } from './first-screen';
import { ProjectStep } from './project-step';
import { FirstChatStep } from './first-chat-step';
import { existingOrgIdFromMe } from './existing-org';
import { emitOnboardingEvent } from './onboarding-telemetry';
import { withProjectParam } from '@/hooks/use-flat-href';
import { resolveOnboardingLandingHref } from '@/lib/onboarding-landing-href';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { desktopApp } from '@/lib/desktop-app';

// story 4715 (UX-1 · plan yuna/4715-plan-1016.md): no organization-name step and no fork. On arrival the page finds the person's
// organization, or their pending invites, or makes the organization with a made name («{name}의 조직» / «내 조직»).
// story 5036 (C6): from there a STRAIGHT LINE of three steps (선생님 11-26) — ① the first project (only its name) → ② connect an agent (three ways side by side:
// new · moved · by key — first-screen.tsx / connect-branches.tsx) → ③ once one has connected, the first conversation in THAT project (first-chat-step.tsx).
// The places that are not a browser keep the screen they had and come through no project step: the Mac app (its own setup page makes the project), the phone app and a
// workspace server host. `?step=project` (an organization exists: a new project from elsewhere — the org switcher) is the project step alone: made → home, no line.
/** story 4763 (H6 · codex): how long the organization-deleted screen waits for its quiet check before it is drawn anyway (the same screen a failed check shows) */
export const DELETED_CHECK_MAX_MS = 8000;

/** story 4763 (H6 · codex): the press has been made — the `?after=org-deleted` of the address goes, so a reload is the usual onboarding */
function forgetOrgDeletedMarker() {
  try { window.history.replaceState(window.history.state, '', window.location.pathname); } catch { /* an address that cannot be changed stays */ }
}

type Step = 'arrive' | 'invited' | 'project' | 'connect' | 'chat' | 'deleted';

/** story 5036: the straight line, in order — the structure test pins this list (a revert turns it red). The ids are the steps' own names; the words are `onboarding.line.step*`. */
export const ONBOARDING_LINE = ['project', 'connect', 'chat'] as const;
export type OnboardingLineStep = (typeof ONBOARDING_LINE)[number];

/** where the step stands on the line (0-based), or null — arrival, invites, the deleted screen have no strip */
export function onboardingLineIndex(step: Step): number | null {
  const at = (ONBOARDING_LINE as readonly string[]).indexOf(step);
  return at < 0 ? null : at;
}

interface OnboardingFormProps {
  /** `project`: an organization exists and a project is asked for from elsewhere (the org switcher) — that step alone, made → home */
  initialStep?: 'project';
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
  /** story 5024 (AC4): this is a workspace SERVER HOST's onboarding — the server's own public address (`https://…`); the first screen then says how to attach an agent to THIS server instead of offering a Mac app. null/absent = not a server host. */
  serverHostOrigin?: string | null;
  /** story 5024 (F1): a server host that has no public address yet (the first owner has just signed up) — the first screen then says «set the public address first» instead of showing the Mac app. false/absent = not that. */
  serverHostPending?: boolean;
  /** story 4763 (H6): the person was sent here by deleting their organization — they are told, and the new one is made on their press (never silently, with the same name) */
  afterOrgDelete?: boolean;
}

/** What arrival is doing: working on it · stopped because the invites could not be read (nothing made) · stopped on another failure ·
 *  story 5036: stopped because the organization's projects could not be read (nothing made: «not read» is not «there is none», or a second project is made) */
type Arrival = 'working' | 'account-check-failed' | 'invite-check-failed' | 'project-check-failed' | 'failed';

const noSubscribe = () => () => undefined;

/** story 5036: the oldest project of the signed-in organization (the list is its own), `null` when there is none, `'unreadable'` when the list could not be read */
async function readOldestProject(): Promise<string | null | 'unreadable'> {
  try {
    const listed = await fetchWithAuth('/api/projects');
    if (!listed.ok) return 'unreadable';
    const body = (await listed.json().catch(() => null)) as { data?: { id: string; created_at?: string }[] } | null;
    if (!body || !Array.isArray(body.data)) return 'unreadable';
    // by the instant (offsets differ), a missing or unreadable time last
    const at = (c?: string) => { const n = c ? Date.parse(c) : NaN; return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; };
    // a row without a usable id is not a project: a list that has rows but none with an id is a list we cannot read — never «there is none» (rule 4832: a second project would be made)
    const usable = body.data.filter((r) => r && typeof r.id === 'string' && r.id !== '');
    if (body.data.length > 0 && usable.length === 0) return 'unreadable';
    const oldest = [...usable].sort((a, b) => at(a.created_at) - at(b.created_at))[0];
    return oldest?.id ?? null;
  } catch {
    return 'unreadable';
  }
}

/** story 5036 · step ② on a browser, the ways that leave the page (the app makes the agent): the organization's activation says an agent has connected — step ③. One watcher while step ② is on screen.
 *  It reads the checklist ITSELF (not through `useActivationStatus`): that hook keeps a failed first read for the whole session and schedules no re-read without a first answer, so a read that failed once would leave
 *  the person on step ② for good (codex 5036). Here every read is a fresh ask: every ASK_MS while the tab is in front, and at once when the tab comes back in front (the person returns from the app). An answer that cannot
 *  be read, or that judged another organization, is «not yet» — asked again, never «connected». */
const ACTIVATION_ASK_MS = 5_000;
function AppConnectWatcher({ onConnected }: { onConnected: () => void }) {
  useEffect(() => {
    let off = false;
    const connectedNow = async (): Promise<boolean> => {
      try {
        const res = await fetchWithAuth('/api/activation/checklist');
        if (!res.ok) return false;
        const data = ((await res.json().catch(() => null)) as { data?: { steps?: { agent_connected?: boolean }; all_complete?: boolean; scope_is_requested_org?: boolean } } | null)?.data;
        if (!data || data.scope_is_requested_org === false) return false;
        return data.steps?.agent_connected === true || data.all_complete === true;
      } catch {
        return false;
      }
    };
    // the first read is made whatever the tab shows (a page opened in the background is read when it opens); the later ones only while the tab is in front
    const ask = async (onlyInFront: boolean) => {
      if (off || (onlyInFront && document.visibilityState !== 'visible')) return;
      if (await connectedNow() && !off) onConnected(); // the page's handler is idempotent
    };
    const askInFront = () => void ask(true);
    void ask(false);
    const tick = setInterval(askInFront, ACTIVATION_ASK_MS);
    window.addEventListener('focus', askInFront);
    document.addEventListener('visibilitychange', askInFront);
    return () => {
      off = true;
      clearInterval(tick);
      window.removeEventListener('focus', askInFront);
      document.removeEventListener('visibilitychange', askInFront);
    };
    // once, while the step is on screen: the page's handler never changes meaning
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function OnboardingForm({
  initialStep, initialOrgId, todayV3Enabled = false, todayHref, chatsHref, macDownloadEnabled = false, serverHostOrigin = null, serverHostPending = false, afterOrgDelete = false,
}: OnboardingFormProps) {
  const t = useTranslations('onboarding');
  const tl = useTranslations('onboarding.line');
  const tc = useTranslations('common');
  const tNewOrg = useTranslations('desktopOnboarding');
  const tSettings = useTranslations('settings');
  const { inPhoneApp } = usePhoneBridge();
  const inMacApp = useSyncExternalStore(noSubscribe, () => !!desktopApp(), () => false);

  const [step, setStep] = useState<Step>(initialStep ?? (afterOrgDelete ? 'deleted' : 'arrive'));
  const [arrival, setArrival] = useState<Arrival>('working');
  const [showDeleteAccount, setShowDeleteAccount] = useState(false); // story #4906: the way out of a person who has no organization any more
  const [invites, setInvites] = useState<MyInvite[]>([]);
  // the organization's name when this page made it — shown on the one screen; null when not known here (never made up)
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(initialOrgId ?? null);
  // story 5036: the project of the line — made by step ①, or the one the organization already had (the oldest)
  const [projectId, setProjectId] = useState<string | null>(null);
  // story 5036: the agent that connected through the key way (null: the app made it, or none yet) — step ③ opens the conversation with it
  const [connectedAgentId, setConnectedAgentId] = useState<string | null>(null);
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
  // story 4904: one «does the person already have an organization?» re-read at a time (the limit answer of createOrg)
  const joiningExisting = useRef(false);

  // story 5036: a place that is not a browser has its own first screen and no project step (the Mac app's setup page makes the project itself; the phone app and a server host never had one)
  const lineApplies = !(serverHostOrigin !== null || serverHostPending || inPhoneApp || inMacApp);
  const lineIndex = !initialStep && lineApplies ? onboardingLineIndex(step) : null;

  // story 4763 (codex): the session is renewed by ONE call at a time for the whole page (`refreshSessionOnce` — the very flight `fetchWithAuth` joins on a 401): the refresh token rotates on use, so
  // the deleted screen's own renewal, the press's, a double press and an interceptor's must share the call in flight, not race it. `refreshAuthTokens` answers `{data, error}` instead of
  // throwing: a missing `data` is not a success either. NO_REFRESH_TOKEN = nothing to renew.
  const renewSession = () => refreshSessionOnce().then(
    (r): 'renewed' | 'nothing-to-renew' | 'failed' => (!r ? 'failed' : r.error ? (r.error.code === 'NO_REFRESH_TOKEN' ? 'nothing-to-renew' : 'failed') : r.data ? 'renewed' : 'failed'),
    () => 'failed' as const,
  );
  // the deleted screen is drawn only after its quiet check has answered (a person who still has an organization must not see «no organization» flash by)
  const [deletedChecked, setDeletedChecked] = useState(false);

  // OB-4: wizard 진입 1회 emit. session_id는 telemetry가 sessionStorage로 1회차당 고정.
  useEffect(() => {
    emitOnboardingEvent('onboarding_started');
  }, []);

  // story 5036: the project of the line is the session's current one (the chat, the board … open on it) — set when it is made and when an existing one is taken
  const adoptProject = async (id: string) => {
    setProjectId(id);
    await fetchWithAuth('/api/current-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: id }),
    }).catch(() => null);
  };

  // story 5036: the organization is known (made now · found · joined) — where the line goes next.
  // A place with no project step goes straight to its own screen. A browser: the organization's own project when it has one (a reload in the middle of the line must never ask for a second —
  // the plan's project limit), else step ①. A list that could not be read is not «there is none» (rule 4832): nothing is made, the person is told and presses [다시 확인].
  const proceedWithOrg = async (org: string) => {
    setOrgId(org);
    if (!lineApplies || desktopApp()) { setStep('connect'); return; }
    const found = await readOldestProject();
    if (found === 'unreadable') { setStep('arrive'); setArrival('project-check-failed'); return; }
    if (found) { await adoptProject(found); setStep('connect'); return; }
    setStep('project');
  };

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
          // story 4904: the limit can be the person's OWN organization, made a moment ago by another window of the same account (a sign-up on the web, the Mac app's login while the web
          // arrival is still making it): the arrival's read (renew, ask again) came before that window's organization was committed, this POST after. «Free plan: 1 organization» is then wrong
          // — they have exactly the one. Ask the database once more through a renewed token (as the arrival does) and, if the organization is there, go on with it. Only when the person
          // chose «초대와 따로 내 조직 만들기» (a second one on purpose) is the limit the answer.
          if (!ownOrgChosen.current && !joiningExisting.current) {
            joiningExisting.current = true;
            try {
              const joined = await readExistingOrg();
              if (joined) { await proceedWithOrg(joined); return; }
            } finally {
              joiningExisting.current = false;
            }
          }
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

      setOrgName(name);
      // E-ONB S5 FINAL: org 생성 시 org_member가 최초 생성됨 → 즉시 토큰 refresh로
      // 새 JWT에 org_id(BE auth Path4 org_member fallback) 반영. 이래야 다음 단계 project 생성의
      // getAuthContext(/api/v2/me)가 통과한다(미refresh 시 fresh JWT엔 team_member 없어 me null → 401).
      // story 4762 — refreshSessionAfterChange(lib/db/client.ts · 한 번에 하나, 바뀐 뒤에 발급)가 새로고침과 함께 셸에 «세션이 바뀌었다»(session-changed)도 알린다: 이 순간 앱이 꺼져도 org 클레임이 든
      // 새 토큰이 디스크에 남도록. 맨 fetch는 이 신호를 안 보냈다(폰 강제 종료 뒤 클레임 없는 옛 토큰이 남아 /glance가 404 — 실측 10-24).
      await refreshSessionAfterChange().catch(() => null); // story 4776 — one rotation at a time for the page, minted after the organization exists
      await proceedWithOrg(json.data.id);
    } catch {
      setError(t('networkError'));
      setArrival('failed');
    }
  };

  // story 4904: the person's organization as the DATABASE says it now — renew the token once (the same shared call as the arrival), ask who they are, take the organization only when its
  // membership is live (`existingOrgIdFromMe`). Anything that cannot be read answers null («not known to exist»), so the limit stays the answer it was.
  const readExistingOrg = async (): Promise<string | null> => {
    if ((await renewSession()) === 'failed') return null;
    try {
      const res = await fetchWithAuth('/api/auth/me');
      if (!res.ok) return null;
      return existingOrgIdFromMe(await res.json());
    } catch {
      return null;
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
      let me: { data?: { member_id?: string | null; org_id?: string | null; org_member_id?: string | null; email_verified?: boolean | null; email_verification_required?: boolean | null; display_name?: string | null } } | null;
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
      if (existing) { await proceedWithOrg(existing); return; }
      // the e-mail gate normally stands before this page; if it is still unverified, say so and make nothing (story #2441)
      // story 5023 (e): only when the server ASKS for it (`email_verification_required` — a server with no mail turns it off, and the page must not ask a person for what that server can never give); a server that says nothing keeps the old behaviour
      if (me?.data?.email_verified === false && me?.data?.email_verification_required !== false) { setEmailVerifyBlocked(true); setArrival('failed'); return; }
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
    // a check that does not answer (a request that hangs) must not leave the person on a spinner for good: after DELETED_CHECK_MAX_MS the screen is drawn as it would be on a failed check (codex)
    const giveUp = setTimeout(() => { if (!off) setDeletedChecked(true); }, DELETED_CHECK_MAX_MS);
    void (async () => {
      // the token the person holds was made before the delete (it still names that organization, and an account with others reads as «none» until it is renewed) — renew, then ask
      if ((await renewSession()) === 'failed') return; // not knowing is not «none», but it is not «has one» either: the screen stays and its press asks again before it makes anything
      const res = await fetchWithAuth('/api/auth/me');
      if (!res.ok) return;
      const existing = existingOrgIdFromMe(await res.json());
      if (existing && !off) { forgetOrgDeletedMarker(); await proceedWithOrg(existing); } // the marker goes too: a reload is the usual onboarding, not this check again
    })().catch(() => undefined).finally(() => { clearTimeout(giveUp); if (!off) setDeletedChecked(true); });
    return () => { off = true; clearTimeout(giveUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // story 5036: the project is an argument — the one made a moment ago is not in the closure yet (the address went without `?p=` before)
  const finishToHome = async (pid: string | null = projectId) => {
    await refreshSessionAfterChange().catch(() => null); // story 4762 — same: the shell writes the new token out now · story 4776 — one rotation at a time, minted after the project and agent exist
    // story #4231 — 첫 착지(flat)는 방금 만든 프로젝트를 싣는다(착지 뒤 셸 ?p= 정규화 왕복 없음).
    window.location.href = withProjectParam(resolveOnboardingLandingHref(todayV3Enabled, todayHref, chatsHref), pid);
  };

  // story 5036: step ① — the project exists. On the line it goes on to step ②; `?step=project` (a new project from elsewhere) ends at home as it always did.
  const handleProjectCreated = async (id: string) => {
    await adoptProject(id);
    if (initialStep === 'project') { await finishToHome(id); return; }
    setStep('connect');
  };

  const handleProjectLimit = (limit: number | null) => {
    setUpgradeReason(t('projectLimitExceededError', { limit: limit ?? 1 }));
    setShowUpgrade(true);
  };

  // story 5036: step ③ — an agent connected (through the key way: its own id · through the app: the organization's activation said so). Told twice (both signals), moved once.
  const handleConnected = (agentId: string | null) => {
    if (agentId) setConnectedAgentId((cur) => cur ?? agentId);
    setStep((cur) => (cur === 'connect' ? 'chat' : cur));
  };

  const handleFinish = () => {
    void finishToHome();
  };

  const finishLabel = todayV3Enabled ? t('desktopFinishToToday') : t('dashboardCta');
  const lineSteps: StepperStep[] = [
    { id: 'project', label: tl('stepProject') },
    { id: 'connect', label: tl('stepConnect') },
    { id: 'chat', label: tl('stepChat') },
  ];

  // story 4763 (H6): the only organization was just deleted — the screen says so; the new organization is made by this press (a second reading of invites included)
  if (step === 'deleted' && !deletedChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4" data-testid="onboarding-org-deleted-checking">
        <p role="status" aria-live="polite" className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <span>{t('arriving')}</span>
        </p>
      </div>
    );
  }
  if (step === 'deleted') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <LegacyCard className="w-full max-w-md space-y-4 p-6 text-center shadow-lg sm:p-8" data-testid="onboarding-org-deleted">
          <h1 className="text-base font-semibold">{t('orgDeletedTitle')}</h1>
          <p className="break-keep text-sm text-muted-foreground">{t('orgDeletedBody')}</p>
          <Button onClick={() => { forgetOrgDeletedMarker(); setStep('arrive'); void arrive(); }} data-testid="onboarding-org-deleted-new">{t('orgDeletedNew')}</Button>
          {/* story #4906 (PO 11-12): a person who deleted their only organization had ONE press here — «new organization» — and /settings sends them back to this page, so «delete account» was out of reach
              (they had to make an organization again first). Two quiet ways out: sign out · delete the account (the same confirmation window as Settings › 계정 삭제). */}
          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-border pt-4">
            <DsButton variant="quiet" onClick={() => { void logoutUser().catch(() => undefined).finally(() => window.location.assign('/login')); }} data-testid="onboarding-org-deleted-logout">{tc('logout')}</DsButton>
            <DsButton variant="quiet" onClick={() => setShowDeleteAccount(true)} data-testid="onboarding-org-deleted-delete-account">{tSettings('deleteAccount')}</DsButton>
          </div>
          {showDeleteAccount ? <DeleteAccountDialog onClose={() => setShowDeleteAccount(false)} onDeleted={() => window.location.assign('/login')} /> : null}
        </LegacyCard>
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
      <Card className="w-full max-w-lg space-y-6 p-6 sm:p-8" data-testid="onboarding-card">
        {/* story 5036: the straight line's strip — three steps, ds Stepper (check · ring · number + a hidden state word: never colour alone). Arrival, invites and the places that are not a browser have none. */}
        {lineIndex !== null ? (
          <div data-testid="onboarding-progress">
            <Stepper
              aria-label={tl('stepperLabel')}
              steps={lineSteps}
              current={lineIndex}
              stateLabels={{ done: tl('stateDone'), current: tl('stateCurrent'), upcoming: tl('stateUpcoming') }}
              data-testid="onboarding-stepper"
            />
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
                <DsButton variant="secondary" size="lg" onClick={() => void arrive()} data-testid="onboarding-account-check-again">{t('inviteCheckAgain')}</DsButton>
              </div>
            ) : arrival === 'invite-check-failed' ? (
              <div className="space-y-3">
                <p role="alert" className="break-keep text-sm text-foreground" data-testid="onboarding-invite-check-failed">{t('inviteCheckFailed')}</p>
                <DsButton variant="secondary" size="lg" onClick={() => void arrive()} data-testid="onboarding-invite-check-again">{t('inviteCheckAgain')}</DsButton>
              </div>
            ) : arrival === 'project-check-failed' ? (
              <div className="space-y-3">
                <p role="alert" className="break-keep text-sm text-foreground" data-testid="onboarding-project-check-failed">{tl('projectCheckFailed')}</p>
                <DsButton variant="secondary" size="lg" onClick={() => { if (orgId) { setArrival('working'); void proceedWithOrg(orgId); } }} data-testid="onboarding-project-check-again">{t('inviteCheckAgain')}</DsButton>
              </div>
            ) : (
              <DsButton variant="secondary" size="lg" onClick={() => void arrive()} data-testid="onboarding-arrive-retry">{tc('retry')}</DsButton>
            )}
          </div>
        )}

        {step === 'project' && orgId ? (
          <ProjectStep orgId={orgId} orgName={orgName} onCreated={handleProjectCreated} onLimit={handleProjectLimit} />
        ) : null}

        {step === 'connect' && (
          <>
            <FirstScreen
              orgId={orgId}
              chatsHref={chatsHref}
              macDownloadEnabled={macDownloadEnabled}
              serverHostOrigin={serverHostOrigin}
              serverHostPending={serverHostPending}
              orgName={orgName}
              projectId={projectId}
              onConnected={(agentId) => handleConnected(agentId)}
              todayV3Enabled={todayV3Enabled}
              todayHref={todayHref}
              onFinish={handleFinish}
            />
            {/* story 5036: the ways that leave the page (the app makes the agent) are told by the organization's activation — only where the line runs */}
            {lineApplies && orgId && projectId ? <AppConnectWatcher onConnected={() => handleConnected(null)} /> : null}
          </>
        )}

        {step === 'chat' && projectId ? (
          <FirstChatStep projectId={projectId} agentId={connectedAgentId} onFinish={handleFinish} finishLabel={finishLabel} />
        ) : null}
      </Card>
      {showUpgrade && <UpgradeModal message={upgradeReason} onClose={() => setShowUpgrade(false)} />}
    </div>
  );
}
