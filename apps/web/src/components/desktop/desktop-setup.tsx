'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fetchWithAuth } from '@/lib/db/client';
import { presetDescription, presetName } from '@/lib/platform-preset-copy';
import { pickEunNeunJosa, pickEuroJosa } from '@/lib/korean-particle';
import { useFlatHref } from '@/hooks/use-flat-href';
import { stageRoleLabel } from '@/lib/stage-role';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { SetupProgressView } from './desktop-setup-progress';
import { defaultOrgName } from '@/app/onboarding/desktop-create-org';
import { onboardingRedirect } from '@/lib/auth/onboarding-next';
import { formatLocaleDate } from '@/lib/i18n';
import { InvisibleSample, useViewerTimeZone } from '@/components/viewer-time-zone';
import { EmailVerifyGateCard, useEmailVerifyGate } from '@/components/auth/email-verify-gate';
import {
  agentRowCount, confirmBody, newOrgConfirmBody, setupFragment, hasSetupFragment, listableRecipe, parseSetupFragment, rememberActiveSetup, type SetupQuery, defaultWorkdirHint, needsAnAgent, setupRoleRows, workdirInputOk,
  type DesktopRuntime, type RowOwner, type SetupRecipe, type SetupRoleRow, withDefaultRecipeFirst } from '@/lib/desktop-setup';

/**
 * story #4427(E-DESKTOP P2) — 웹 설정 페이지. 데스크톱 앱이 이 페이지를 설정 코드 + 찾은 에이전트 목록과 함께 연다.
 * 모든 고를 것이 기본값으로 채워진 채 열리고 사람은 «시작» 한 번만 누른다(유나 시안 v3 · 사람 손 ≤ 3).
 * 실패는 «무엇이 · 왜 · 할 일 하나»(빨강 X · 설명 링크 0 · 요금제 말 0). 앱을 부르는 단추는 `ai.sprintable:/desktop/setup`
 * 링크로만(웹 쪽 preload 0 — 셸이 그 링크를 받아 새 코드로 다시 연다).
 */
export const SETUP_APP_LINK = 'ai.sprintable:/desktop/setup';
const RUNTIME_LABEL: Record<DesktopRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };
// each provider's recommended install (no Node.js needed; fixed provider addresses with no version in them — PO 13:10Z from
// code.claude.com/docs/en/setup and github.com/openai/codex)
const INSTALL: Record<DesktopRuntime, string> = { claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' };

export type SetupFailure = 'no-agent' | 'not-admin' | 'agent-limit' | 'expired' | 'offline' | 'managed' | 'no-recipe' | 'recipes-offline' | 'recipe-too-big' | 'recipes-changed' | 'has-org';

/** 실패 화면 문구 키 — `Record<string, string>` 리터럴 표(키 가드가 이 모양의 값을 «읽힘»으로 센다). */
const FAILURE_KEY: Record<string, string> = {
  'no-agent.title': 'failure.no-agent.title', 'no-agent.body': 'failure.no-agent.body', 'no-agent.action': 'failure.no-agent.action',
  'not-admin.title': 'failure.not-admin.title', 'not-admin.body': 'failure.not-admin.body', 'not-admin.action': 'failure.not-admin.action',
  'agent-limit.title': 'failure.agent-limit.title', 'agent-limit.body': 'failure.agent-limit.body', 'agent-limit.action': 'failure.agent-limit.action',
  'expired.title': 'failure.expired.title', 'expired.body': 'failure.expired.body', 'expired.action': 'failure.expired.action',
  'offline.title': 'failure.offline.title', 'offline.body': 'failure.offline.body', 'offline.action': 'failure.offline.action',
  'managed.title': 'failure.managed.title', 'managed.body': 'failure.managed.body', 'managed.action': 'failure.managed.action',
  'no-recipe.title': 'failure.no-recipe.title', 'no-recipe.body': 'failure.no-recipe.body', 'no-recipe.action': 'failure.no-recipe.action',
  'recipes-offline.title': 'failure.recipes-offline.title', 'recipes-offline.body': 'failure.recipes-offline.body', 'recipes-offline.action': 'failure.recipes-offline.action',
  // the button is ③'s «레시피 다시 고르기» (Yuna v20: the same action, the same words)
  'recipes-changed.title': 'failure.recipes-changed.title', 'recipes-changed.body': 'failure.recipes-changed.body', 'recipes-changed.action': 'failure.recipes-changed.action',
  'recipe-too-big.title': 'failure.recipe-too-big.title', 'recipe-too-big.body': 'failure.recipe-too-big.body', 'recipe-too-big.action': 'failure.agent-limit.action',
  'has-org.title': 'failure.has-org.title', 'has-org.body': 'failure.has-org.body', 'has-org.action': 'failure.has-org.action',
};

/** confirm 오류 코드(4424 닫힌 목록) → 실패 화면. 목록 밖 코드는 null(화면이 지어내지 않는다 — 한 줄 일반 문구). */
export function failureForCode(code: string | undefined, resource?: string): SetupFailure | null {
  // 에이전트 한도(Didi 08:34Z): 402 PLAN_LIMIT_EXCEEDED · resource=agent — 요금제 말 없이 ③
  if (code === 'PLAN_LIMIT_EXCEEDED') return resource === 'agent' ? 'agent-limit' : null;
  switch (code) {
    case 'not_org_admin':
    case 'person_session_required':
      return 'not-admin';
    case 'code_expired':
    case 'code_used':
      return 'expired';
    // the recipe is over the confirm body's limits (more than 50 roles · a role name over 200 characters): trying again gives
    // the same answer, so «다른 레시피», not «잠시 뒤 다시» (Kadir 4834 · PO 05:21Z · Didi 4838's closed code · Yuna v20)
    case 'recipe_too_large':
      return 'recipe-too-big';
    // the rows the page sent no longer match the recipe (the web never sends a row outside the list it was given): the list
    // changed since the page read it — read it again and choose, never «잠시 뒤 다시» (PO 06:08Z). no_agent_role is the same
    // case: the page keeps «시작» off with no agent row, so it only comes when the recipe changed meanwhile — ① («에이전트를
    // 찾지 못했어요») would be false there, agents were found (Yuna · PO 06:52Z)
    case 'roles_invalid':
    case 'no_agent_role':
      return 'recipes-changed';
    // (나) confirm-new-org: an organization appeared since the page looked (another tab · another device) — reload into it
    case 'has_organization':
      return 'has-org';
    default:
      return null;
  }
}

/** ③ 한도의 수는 서버 오류가 준 값만(유나 표) — 이번 설정에 필요한 수와 더 만들 수 있는 수가 둘 다 있을 때만 수 문장. */
export interface LimitCounts { need: number; left: number }
export function limitCounts(error: { needed?: unknown; available?: unknown } | undefined): LimitCounts | null {
  const need = error?.needed; const left = error?.available;
  return typeof need === 'number' && typeof left === 'number' && need > left && left >= 0 ? { need, left } : null;
}

/**
 * (나) after the server made the organization and its project with the setup: a fresh token that carries the organization, the
 * project as the current one, a fresh token again — the order the one-screen «조직 만들기» uses (Mirko 02:26Z). The setup is
 * already committed, so a failed step here does not stop the progress view (it reads by the setup id).
 */
async function joinNewOrg(body: { project_id?: string; data?: { project_id?: string } } | null): Promise<boolean> {
  const projectId = body?.project_id ?? body?.data?.project_id;
  if (!(await renewToken())) return false;
  if (projectId) {
    await fetchWithAuth('/api/current-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId }),
    }).catch(() => null);
  }
  return renewToken();
}

/**
 * A new token that carries the new organization (4429 ①): an answer that is not ok (401 · 5xx) is a failure too — not only a
 * network error — and it is tried once more. Without it the progress cannot be read with the old token.
 */
export async function renewToken(): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    const ok = await fetchWithAuth('/api/auth/refresh', { method: 'POST' }).then((r) => r.ok, () => false);
    if (ok) return true;
  }
  return false;
}

/** The address a reload goes to for this setup's progress (4429 ①): the setup id only — no code (it is used already). */
export const PROGRESS_FRAGMENT = (setupId: string) => `#progress=${encodeURIComponent(setupId)}`;
function reloadToProgress(setupId: string): void {
  // replaceState, not `location.hash =`: no hashchange for the page's own handler (same as 4429 ②)
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + PROGRESS_FRAGMENT(setupId));
  window.location.reload();
}

/**
 * The setup is saved but its progress cannot be read with the old token (4429 ① · Yuna 09:42Z): in the progress's place, not over
 * it — «앱이 받아 가기를 기다리는 중» would say what the page does not know. No red: only «seeing» is blocked.
 */
export function SetupDoneReload({ setupId }: { setupId: string | null }) {
  const t = useTranslations('desktop.setup');
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="setup-done-reload">
      <h1 className="text-lg font-semibold">{t('doneReload.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('doneReload.body')}</p>
      <div className="flex gap-2">
        <Button onClick={() => (setupId ? reloadToProgress(setupId) : window.location.reload())}>{t('failure.has-org.action')}</Button>
      </div>
    </Card>
  );
}

type View =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'starting' }
  | { kind: 'started' }
  /** saved on the server, but the new token could not be had: the progress cannot be read here (4429 ①) */
  | { kind: 'done-reload' }
  /** `retry`: what «다시 시도 / 다시 확인» does — read the list again, or send the confirm again. */
  | { kind: 'failed'; failure: SetupFailure; counts?: LimitCounts | null; retry?: 'load' | 'confirm' }
  /** `message`: a line the new-organization start can say instead of the generic one (e-mail not verified · org/project limit). */
  | { kind: 'error'; message?: string };

/** A pending invite to this person's own verified e-mail (GET /api/invites/mine · 4833) — no token: accepting stays the mail link. */
export interface MyInvite { invite_id: string; org_id: string; org_name: string; role: string; expires_at: string }

/**
 * story #4427 (나) — where a person with no organization stands (design doc 9a4cb445 · PO 02:23Z). `has-org` = the usual page.
 * `checking` = asking for their invites; `new` = «시작» also makes a new organization and its first project; `invited` = they were
 * invited somewhere, so the page makes nothing and says where to go. An invite read that fails sends them to 4832's one-screen
 * «조직 만들기» instead — not knowing is not taken as «no invites».
 */
type OrgMode = { kind: 'has-org' } | { kind: 'checking' } | { kind: 'new' } | { kind: 'invited'; invites: MyInvite[] };

function ownerKey(o: RowOwner): string { return o.kind === 'me' ? 'me' : o.runtime; }

export function DesktopSetup({ code, runtimes: found, blocked = [], setupId = null }: { code: string; runtimes: DesktopRuntime[]; blocked?: DesktopRuntime[]; setupId?: string | null }) {
  // ⑥ 갈래 가: 찾았지만 회사 설정으로 도구를 못 붙이는 런타임은 고를 수 없고, 꺼진 선택지로만 보인다. PO 08:37Z · 유나 08:38Z.
  const runtimes = useMemo(() => found.filter((r) => !blocked.includes(r)), [found, blocked]);
  const claudeBlocked = blocked.includes('claude');
  const t = useTranslations('desktop.setup');
  const tPreset = useTranslations('recipePreset');
  const tOrg = useTranslations('organization');
  const tNewOrg = useTranslations('desktopOnboarding');
  const tOnboarding = useTranslations('onboarding');
  const { projectId, userName, orgId, orgMemberships } = useDashboardContext();
  const [orgMode, setOrgMode] = useState<OrgMode>(() => (orgId ? { kind: 'has-org' } : { kind: 'checking' }));
  const newOrg = orgMode.kind === 'new';
  // story #4453 — a new organization needs a verified e-mail: that step comes first, not after «시작» (a 403 at the end).
  // Once it opens, read the invites again: the server lists them only for a verified address, so an invited person was
  // «new» while unverified — without this they would meet their invite only after «시작» (pending_invites · PO 05:07Z)
  const verifyGate = useEmailVerifyGate(newOrg, () => { setOrgMode({ kind: 'checking' }); void readInvites(); });
  const [orgName, setOrgName] = useState('');
  const [projectName, setProjectName] = useState('');
  const [editingNames, setEditingNames] = useState(false);
  const orgNameTouched = useRef(false);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const myName = userName ?? displayName ?? '';
  // 에이전트를 만드는 건 조직 owner/admin(4424 not_org_admin) — 조직 역할은 orgMemberships(content-rules와 같은 판정)
  const orgRole = orgMemberships?.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = orgRole === 'owner' || orgRole === 'admin';
  const [recipes, setRecipes] = useState<SetupRecipe[]>([]);
  const [recipeId, setRecipeId] = useState<string>('');
  const [rows, setRows] = useState<SetupRoleRow[]>([]);
  const [workdir, setWorkdir] = useState('');
  const [editingDir, setEditingDir] = useState(false);
  const [pickingRecipe, setPickingRecipe] = useState(false); // 4446: the recipe list is folded to the chosen one until [바꾸기]
  // keyboard focus follows the fold (Yuna 00:54Z): opening puts it on the chosen recipe, folding puts it back on [바꾸기].
  // [바꾸기] stays in its place while the list is open (Qadir 4869: a disclosure whose button exists only while folded says
  // «collapsed» forever and controls a list that never exists) — it shows the state and folds the list again.
  const recipeListRef = useRef<HTMLDivElement | null>(null);
  const recipeChangeRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterFold = useRef<'list' | 'change' | null>(null);
  // the list's order is fixed when it opens (the chosen one first) — arrow keys change the choice while it is open, and a
  // list that re-sorted on every choice would move under the person's keyboard (Yuna 02:56Z)
  const [recipeOrder, setRecipeOrder] = useState<string[]>([]);
  const openRecipes = () => {
    setRecipeOrder([...recipes].sort((a, b) => Number(b.id === recipeId) - Number(a.id === recipeId)).map((r) => r.id));
    focusAfterFold.current = 'list';
    setPickingRecipe(true);
  };
  // folding (Yuna 02:56Z): never on an arrow key (that only chooses), but on a real click, Enter or Space, [바꾸기] again, or
  // focus leaving the list. Focus goes back to [바꾸기] — except when it left for another control (a Tab · a click elsewhere)
  // or the window itself lost focus (PO 03:41Z: never pull focus inside a window the person left).
  const foldRecipes = (refocus: boolean) => {
    focusAfterFold.current = refocus ? 'change' : null;
    setPickingRecipe(false);
  };
  useEffect(() => {
    const where = focusAfterFold.current;
    focusAfterFold.current = null;
    if (where === 'list') recipeListRef.current?.querySelector<HTMLInputElement>('input[name=recipe]:checked')?.focus();
    if (where === 'change') recipeChangeRef.current?.focus();
  }, [pickingRecipe]);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [rateLine, setRateLine] = useState<string | null>(null);

  // 로그인이 필요했던 설정이면 한 번(4426 · 사람 손 셈) — 설정 id가 없으면 이 흐름에 묶을 수 없어 보내지 않는다
  useEffect(() => {
    if (!setupId) return;
    rememberActiveSetup(setupId); // 이 탭에서 문서를 열면 desktop_doc_opened로 셈(DesktopSetupDocWatch)
  }, [setupId]);

  // (나) no organization: their invites decide the mode (0 → a new organization · some → where to go · unreadable → (가))
  async function readInvites() {
    try {
      const res = await fetchWithAuth('/api/invites/mine');
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const list: unknown = body?.invites ?? body?.data?.invites;
      if (!Array.isArray(list)) throw new Error('no list');
      setOrgMode(list.length ? { kind: 'invited', invites: list as MyInvite[] } : { kind: 'new' });
    } catch {
      window.location.assign(onboardingRedirect(window.location.pathname)); // this page → /onboarding?next=… (4832)
    }
  }
  useEffect(() => {
    if (!orgId) void readInvites();
  }, [orgId]);

  // (나) the new organization's names: the same defaults as the one-screen «조직 만들기» (4832) — «{표시 이름}의 조직» (40 at most)
  // or «내 조직», never the e-mail; «첫 프로젝트». The display name comes from /api/auth/me; a name already typed is kept.
  useEffect(() => {
    if (!newOrg) return;
    let off = false;
    const fallback = tNewOrg('defaultOrgName');
    setOrgName((n) => n || fallback);
    setProjectName((n) => n || tNewOrg('defaultProjectName'));
    fetchWithAuth('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { display_name?: string | null } } | null) => {
        if (off) return;
        const name = json?.data?.display_name ?? null;
        setDisplayName(name);
        if (!orgNameTouched.current) setOrgName(defaultOrgName(name, (n) => tNewOrg('defaultOrgNameWithName', { name: n }), fallback));
      })
      .catch(() => { /* keep «내 조직» */ });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newOrg]);

  // bumped by «다시 확인 / 다시 시도» after the list could not be read or came back empty — reads the list again
  const [loadTick, setLoadTick] = useState(0);
  const reload = () => { setView({ kind: 'loading' }); setLoadTick((n) => n + 1); };

  useEffect(() => {
    if (orgMode.kind !== 'has-org' && orgMode.kind !== 'new') return; // no list until the mode is known (and none when invited)
    let off = false;
    void (async () => {
      try {
        // the recipes this setup can start, each with its rows — worked out by the server with the function confirm checks
        // with (4831): the page draws them as they come (list order = the default is the first — no «recommended» tag)
        // a person with no organization reads the platform presets through their own path (the usual one needs an
        // organization — §9 of design doc 9a4cb445); same shape, same drawing
        const res = await fetchWithAuth(newOrg ? '/api/desktop/recipes/for-new-org' : '/api/desktop/recipes');
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        const list: SetupRecipe[] = body?.recipes ?? body?.data?.recipes ?? [];
        // the default recipe first and chosen when it is there (PO 10:40Z ② · Yuna v23) — not whatever the server sorted first
        const usable = withDefaultRecipeFirst(list.filter((d) => listableRecipe(d, presetName(d, tPreset))));
        if (off) return;
        setRecipes(usable);
        if (usable[0]) pick(usable[0]);
        setView(usable.length ? { kind: 'choose' } : { kind: 'failed', failure: 'no-recipe', retry: 'load' });
      } catch {
        // not ⑤: nothing is chosen yet, so «고른 레시피와 설정은 그대로» would be false (PO 01:00Z · Yuna v18)
        if (!off) setView({ kind: 'failed', failure: 'recipes-offline', retry: 'load' });
      }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTick, orgMode.kind]);

  function pick(r: SetupRecipe) {
    setRecipeId(r.id);
    setRows(setupRoleRows(r, runtimes));
    setWorkdir(defaultWorkdirHint(presetName(r, tPreset)));
    setEditingDir(false);
  }

  const recipe = recipes.find((r) => r.id === recipeId);
  const roleName = (role: string) => stageRoleLabel(role, tOrg);
  const humanRoles = useMemo(() => rows.filter((r) => r.owner.kind === 'me').map((r) => stageRoleLabel(r.role, tOrg)), [rows, tOrg]);
  const humanList = humanRoles.join(' · ');
  const agents = agentRowCount(rows);

  async function start() {
    if (!recipe || (!newOrg && !projectId)) return;
    setRateLine(null);
    setView({ kind: 'starting' });
    try {
      const res = newOrg
        ? await fetchWithAuth('/api/desktop/setup-codes/confirm-new-org', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newOrgConfirmBody(code, rows, recipe.id, workdir, orgName, projectName)),
        })
        : await fetchWithAuth('/api/desktop/setup-codes/confirm', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(confirmBody(code, rows, projectId!, recipe.id, workdir)),
        });
      if (res.ok) {
        if (newOrg && !(await joinNewOrg(await res.json().catch(() => null)))) { setView({ kind: 'done-reload' }); return; }
        setView({ kind: 'started' });
        return;
      }
      const body = await res.json().catch(() => null);
      const error = body?.error as { code?: string; resource?: string } | undefined;
      // too many tries in a short time (4429 ③ · Yuna f6cfda19 v5): a line in the error line's place and «시작» left on — trying
      // again is true, just later; no extra button, no countdown
      if (res.status === 429 || error?.code === 'RATE_LIMITED') {
        const secs = Number(res.headers.get('Retry-After'));
        const time = !Number.isFinite(secs) || secs <= 0 ? t('rateLimitedMoment')
          : secs < 60 ? t('rateLimitedSeconds', { n: Math.ceil(secs) }) : t('rateLimitedMinutes', { n: Math.ceil(secs / 60) });
        setRateLine(t('rateLimited', { time }));
        setView({ kind: 'choose' });
        return;
      }
      // (나) an invite arrived between the page's look and «시작» (the server checks again): the invite card, nothing made
      if (newOrg && error?.code === 'pending_invites') {
        await readInvites();
        // the invite was withdrawn meanwhile and the list came back empty: the choice again, never a «시작 중» that never ends (4429 ④)
        setView((v) => (v.kind === 'starting' ? { kind: 'choose' } : v));
        return;
      }
      // (나) the words the one-screen «조직 만들기» uses for the same refusals (4832 · Yuna: «같은 오류는 같은 말»)
      const limit = typeof (error as { limit?: unknown } | undefined)?.limit === 'number' ? (error as { limit: number }).limit : 1;
      const message = !newOrg ? null
        : error?.code === 'EMAIL_VERIFICATION_REQUIRED' ? tOnboarding('emailVerifyRequiredError')
        : error?.code === 'PLAN_LIMIT_EXCEEDED' && error.resource === 'org' ? tOnboarding('orgLimitExceededError', { limit })
        : error?.code === 'PLAN_LIMIT_EXCEEDED' && error.resource === 'project' ? tOnboarding('projectLimitExceededError', { limit })
        : null;
      if (message) { setView({ kind: 'error', message }); return; }
      const failure = failureForCode(error?.code, error?.resource);
      setView(failure ? { kind: 'failed', failure, counts: failure === 'agent-limit' ? limitCounts(body?.error) : null, retry: failure === 'recipes-changed' ? 'load' : undefined } : { kind: 'error' });
    } catch {
      setView({ kind: 'failed', failure: 'offline', retry: 'confirm' });
    }
  }

  if (orgMode.kind === 'invited') return <InvitedCard invites={orgMode.invites} />;
  if (newOrg && verifyGate.kind === 'closed') return <EmailVerifyGateCard gate={verifyGate} />;
  if (newOrg && verifyGate.kind === 'reading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  // a person making a new organization is its owner-to-be: the server checks «no organization» itself (org_members 0 rows)
  if (orgMode.kind === 'has-org' && !isAdmin && view.kind !== 'loading') return <Failure failure="not-admin" />;
  if (view.kind === 'loading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (view.kind === 'failed') {
    const onRetry = view.retry === 'load' ? reload : view.failure === 'offline' ? () => void start() : undefined;
    // «이미 조직이 있어요» [다시 불러오기]: reload with the setup values put back into the fragment — they are only in memory now
    // (the page took them off the address), and a bare reload showed «데스크톱 앱에서 열어 주세요» (4429 ②)
    const onReloadPage = view.failure === 'has-org'
      // replaceState, not `location.hash =`: no hashchange (the page's own handler would take the values off again before the reload)
      ? () => {
        window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + setupFragment({ code, runtimes: found, setupId, blocked }));
        window.location.reload();
      }
      : undefined;
    return <Failure failure={view.failure} counts={view.counts ?? null} onRetry={onRetry} onReloadPage={onReloadPage}
      onChooseRecipe={view.failure === 'agent-limit' || view.failure === 'recipe-too-big' ? () => setView({ kind: 'choose' }) : undefined} />;
  }
  // 쓸 수 있는 런타임이 하나도 없을 때: 막힌 것만 있으면 ⑥ 전체 화면, 아무것도 못 찾았으면 ①
  if (runtimes.length === 0 && needsAnAgent(rows)) return <Failure failure={blocked.length > 0 ? 'managed' : 'no-agent'} />;
  if (view.kind === 'done-reload') return <SetupDoneReload setupId={setupId} />;
  if (view.kind === 'started') return <SetupProgressView setupId={setupId} recipeName={recipe ? presetName(recipe, tPreset) : ''} />;

  const setOwner = (role: string, key: string) => setRows((rs) => rs.map((r) => (r.role === role ? { ...r, owner: r.choices.find((c) => ownerKey(c) === key) ?? r.owner } : r)));
  // agents found but every either row set to «나»: «시작» off with the reason in the count line's place (Yuna v21 — n = 0 there
  // would be false); the server refuses the same with no_agent_role
  const noAgentRow = needsAnAgent(rows);
  const namesOk = !newOrg || (!!orgName.trim() && !!projectName.trim());
  const canStart = !!recipe && (newOrg || !!projectId) && namesOk && !noAgentRow && workdirInputOk(workdir) && view.kind === 'choose';

  return (
    <Card className="break-keep flex flex-col gap-6 p-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')}</p>
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('lead')}</p>
      </header>

      {newOrg ? (
        <section aria-label={tNewOrg('orgLabel')} data-testid="setup-new-org">
          {editingNames ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium">{tNewOrg('orgLabel')}
                <Input value={orgName} maxLength={100} onChange={(e) => { orgNameTouched.current = true; setOrgName(e.target.value); }} />
                {!orgName.trim() ? <span className="text-xs font-normal text-muted-foreground">{tNewOrg('orgRequired')}</span> : null}
              </label>
              <label className="flex flex-col gap-1 text-sm font-medium">{tNewOrg('projectLabel')}
                <Input value={projectName} maxLength={100} onChange={(e) => setProjectName(e.target.value)} />
                {!projectName.trim() ? <span className="text-xs font-normal text-muted-foreground">{tNewOrg('projectRequired')}</span> : null}
              </label>
              <p className="text-xs text-muted-foreground">{t('newOrg.later')}</p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted p-3">
              <p className="min-w-0 text-sm">{t('newOrg.line', { name: orgName })}</p>
              {/* the page has three [바꾸기]: each says what it changes to a screen reader (Qadir 4866 2nd line) — the shown word stays */}
              <Button variant="ghost" size="sm" aria-label={t('changeNewOrgAria')} onClick={() => setEditingNames(true)}>{t('change')}</Button>
            </div>
          )}
        </section>
      ) : null}

      {/* the chosen recipe as one card + [바꾸기] — the list of every recipe pushed «시작» more than a screen below, and a
          person who did not scroll saw no agent start (4446 · Yuna b2d15f85 ① · PO 00:31Z). [바꾸기] opens the list below the
          card (the chosen one first) and stays there while it is open; picking one folds it again. One recipe only: no [바꾸기]. */}
      <section aria-labelledby="setup-recipe">
        <h2 id="setup-recipe" className="text-sm font-medium">{t('recipe')}</h2>
        {recipe ? (
          <div className="mt-2 flex items-start justify-between gap-3 rounded-md border p-3" data-testid="setup-recipe-chosen">
            {/* while the list is open the card is the current value in one line — the list below is where one chooses, and
                the primary border is only on the checked radio there (Yuna 03:53Z: one place says «chosen») */}
            <span className="min-w-0"><span className="block text-sm font-medium">{presetName(recipe, tPreset)}</span>
              {!pickingRecipe && presetDescription(recipe, tPreset) ? <span className="block text-xs text-muted-foreground">{presetDescription(recipe, tPreset)}</span> : null}
              {!pickingRecipe ? <RecipeRolesLine recipe={recipe} runtimes={runtimes} /> : null}</span>
            {recipes.length > 1 ? (
              <Button ref={recipeChangeRef} variant="ghost" size="sm" aria-label={t('changeRecipeAria')} aria-expanded={pickingRecipe} aria-controls="setup-recipe-list"
                onClick={() => (pickingRecipe ? foldRecipes(true) : openRecipes())}>{t('change')}</Button>
            ) : null}
          </div>
        ) : null}
        {pickingRecipe ? (
          <div role="radiogroup" aria-labelledby="setup-recipe" className="mt-2 flex flex-col gap-2" data-testid="setup-recipe-list" id="setup-recipe-list" ref={recipeListRef}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              // a screen reader can put focus on a radio without choosing it: Enter/Space there chooses that one (PO 03:41Z)
              const el = e.target as HTMLInputElement;
              if (el.name === 'recipe' && !el.checked) { const r = recipes.find((x) => x.id === el.value); if (r) pick(r); }
              foldRecipes(true);
            }}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (e.currentTarget.contains(to) || to === recipeChangeRef.current) return; // [바꾸기]'s own click folds it
              foldRecipes(to === null && document.hasFocus());
            }}>
            {recipeOrder.map((id) => recipes.find((x) => x.id === id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => (
              // a real click (detail ≥ 1) chooses and folds; the click an arrow key or a label sends to the radio has detail 0
              <label key={r.id} className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary"
                onClick={(e) => { if (e.detail > 0) foldRecipes(true); }}>
                <input type="radio" name="recipe" value={r.id} checked={r.id === recipeId} onChange={() => pick(r)} className="mt-1" />
                <span><span className="block text-sm font-medium">{presetName(r, tPreset)}</span>
                  {presetDescription(r, tPreset) ? <span className="block text-xs text-muted-foreground">{presetDescription(r, tPreset)}</span> : null}
                  <RecipeRolesLine recipe={r} runtimes={runtimes} /></span>
              </label>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="setup-roles">
        <h2 id="setup-roles" className="text-sm font-medium">{t('rolesTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('found', { list: runtimes.map((r) => RUNTIME_LABEL[r]).join(' · ') || '—' })}</p>
        <ul className="mt-2 flex flex-col divide-y rounded-md border">
          {rows.map((r) => (
            <li key={r.role} className="flex items-center justify-between gap-3 p-3">
              <span className="min-w-0 break-keep">
                <span className="block text-sm font-medium">{roleName(r.role)}</span>
                <span className="block text-xs text-muted-foreground">{r.actor === 'human' ? t('whoHuman') : r.actor === 'either' ? t('whoEither') : t('whoAgent')}</span>
              </span>
              {r.choices.length === 1
                ? <span className="text-sm">{r.owner.kind === 'me' ? t('me', { name: myName }) : t('onThisComputer', { runtime: RUNTIME_LABEL[r.owner.runtime] })}</span>
                : (
                  <select aria-label={t('ownerFor', { role: roleName(r.role) })} className="max-w-[55%] shrink-0 rounded-md border bg-background px-2 py-1 text-base lg:text-sm"
                    value={ownerKey(r.owner)} onChange={(e) => setOwner(r.role, e.target.value)}>
                    {r.choices.map((c) => <option key={ownerKey(c)} value={ownerKey(c)}>{c.kind === 'me' ? t('me', { name: myName }) : RUNTIME_LABEL[c.runtime]}</option>)}
                    {claudeBlocked && r.actor !== 'human' ? <option value="claude-blocked" disabled>{t('blockedClaudeOption')}</option> : null}
                  </select>
                )}
            </li>
          ))}
        </ul>
        {claudeBlocked && runtimes.length > 0 ? <p className="mt-2 text-xs text-muted-foreground" data-testid="setup-blocked-note">{t('blockedClaudeNote')}</p> : null}
        <p className="mt-2 text-xs text-muted-foreground">{t('humanNote')}</p>
      </section>

      <section aria-labelledby="setup-folder">
        <h2 id="setup-folder" className="text-sm font-medium">{t('folder')}</h2>
        {editingDir
          ? <Input aria-labelledby="setup-folder" className="mt-2 font-mono" value={workdir} onChange={(e) => setWorkdir(e.target.value)} />
          : (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border p-3">
              <code className="min-w-0 truncate text-sm">{workdir}</code>
              <Button variant="ghost" size="sm" aria-label={t('changeFolderAria')} onClick={() => setEditingDir(true)}>{t('change')}</Button>
            </div>
          )}
        {!workdirInputOk(workdir) ? <p className="mt-1 text-xs text-muted-foreground">{t('folderHint')}</p> : null}
      </section>

      {/* what the agents ask and what they do not (PO 00:41Z · Yuna v17): Sprintable's own tools are pre-allowed; files ·
          commands · other tools still ask each time — at the end of the flow, just above the start row (4446) */}
      <p className="text-xs text-muted-foreground">{t('toolNote')}</p>

      {/* «시작» and its one line stay in sight (4446 · Yuna b2d15f85 ② · PO 00:31Z): stuck to the bottom of whatever scrolls —
          the window for a new organization, the app shell's main area for an existing one — on the card's own background, a thin
          line above. Spans the card's padding so it reads as the card's last row. */}
      <footer className="sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-2 rounded-b-[inherit] border-t bg-card px-6 pt-3 pb-6" data-testid="setup-start-row">
        <Button onClick={() => void start()} disabled={!canStart}>
          {view.kind === 'starting' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t('start')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {noAgentRow ? t('noAgentRow')
            : humanRoles.length > 0 ? t('startNoteWithMe', { n: agents, roles: humanList, josa: pickEunNeunJosa(humanList) }) : t('startNote', { n: agents })}
        </p>
        {rateLine ? <p className="text-xs text-muted-foreground" data-testid="setup-rate-limited">{rateLine}</p>
          : view.kind === 'error' ? <p className="text-xs text-muted-foreground">{view.message ?? t('genericError')}</p> : null}
      </footer>
    </Card>
  );
}

export function Failure({ failure, onRetry, counts = null, onChooseRecipe, onReloadPage }: { failure: SetupFailure; onRetry?: () => void; counts?: LimitCounts | null; onChooseRecipe?: () => void; onReloadPage?: () => void }) {
  const t = useTranslations('desktop.setup');
  const flatHref = useFlatHref();
  const key = (part: 'title' | 'body' | 'action') => FAILURE_KEY[`${failure}.${part}`]!;
  const appButton = (label: string) => <Button asChild><a href={SETUP_APP_LINK}>{label}</a></Button>;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">{t(key('title'))}</h1>
      <p className="text-sm text-muted-foreground">
        {failure === 'agent-limit' && counts ? <>{t('failure.agent-limit.bodyWithCounts', { need: counts.need, left: counts.left })} </> : null}{t(key('body'))}
      </p>
      {failure === 'no-agent' ? (
        <ul className="flex flex-col gap-2">
          {(Object.keys(INSTALL) as DesktopRuntime[]).map((r) => (
            <li key={r} className="flex items-center justify-between gap-3 rounded-md border p-2">
              <code className="min-w-0 truncate text-xs">{INSTALL[r]}</code>
              <Button variant="ghost" size="sm" aria-label={t('failure.copyAria', { runtime: RUNTIME_LABEL[r] })} onClick={() => void navigator.clipboard?.writeText(INSTALL[r]).catch(() => {})}>{t('failure.copy')}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        {failure === 'no-agent' ? appButton(t(key('action')))
          : failure === 'expired' ? appButton(t(key('action')))
          : (failure === 'offline' || failure === 'no-recipe' || failure === 'recipes-offline' || failure === 'recipes-changed') && onRetry ? <Button onClick={onRetry}>{t(key('action'))}</Button>
          : failure === 'not-admin' || failure === 'managed' || failure === 'has-org' ? <Button onClick={onReloadPage ?? (() => window.location.reload())}>{t(key('action'))}</Button>
          : failure === 'recipe-too-big' && onChooseRecipe ? <Button onClick={onChooseRecipe}>{t(key('action'))}</Button>
          : failure === 'agent-limit' ? <>
            {onChooseRecipe ? <Button onClick={onChooseRecipe}>{t(key('action'))}</Button> : null}
            <Button variant="outline" asChild><a href={flatHref('/organization/workforce')}>{t('failure.agent-limit.manage')}</a></Button>
          </>
          : null}
      </div>
    </Card>
  );
}

/** (나) the invite's last day as the web's notifications say dates (Yuna 02:46Z): month name + day, the year only when it is not
 * this year — ko «10월 6일» · en "Oct 6" · another year ko «2027년 1월 6일» · en "Jan 6, 2027". */
export function inviteUntilDate(value: string, locale: string, timeZone: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return ''; // an unreadable value: nothing, as before (Kadir 4865 ⓑ — the year below would throw)
  const ko = locale.startsWith('ko');
  // story #4443 PR2 — the viewer's day and year (an invite ending 23:00Z ends the next day in Seoul)
  const year = (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d);
  return formatLocaleDate(date, locale, { month: ko ? 'long' : 'short', day: 'numeric', ...(year(date) !== year(now) ? { year: 'numeric' } : {}) }, timeZone);
}

/**
 * (나) invited somewhere (Yuna f6cfda19 v2): the page makes nothing and has no button — the invite is taken through the mail link
 * (no token here). One line per invite: who invited · as what · until when.
 */
export function InvitedCard({ invites }: { invites: MyInvite[] }) {
  const t = useTranslations('desktop.setup');
  const locale = useLocale();
  const viewerTz = useViewerTimeZone(); // story #4443 PR2 — unknown yet: the row's place is held, no UTC day shown
  const inviteRow = (i: MyInvite) => {
    const role = i.role === 'admin' ? t('invited.roleAdmin') : t('invited.roleMember');
    const row = t('invited.row', { org: i.org_name, role, josa: pickEuroJosa(role), date: inviteUntilDate(i.expires_at, locale, viewerTz ?? 'UTC') });
    return viewerTz ? row : <InvisibleSample>{row}</InvisibleSample>;
  };
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="setup-invited">
      <h1 className="text-lg font-semibold">{t('invited.title')}</h1>
      <ul className="flex flex-col gap-1">
        {invites.map((i) => (
          <li key={i.invite_id} className="text-sm">
            {inviteRow(i)}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t('invited.action')}</p>
    </Card>
  );
}

/**
 * ⑦ 원인 모름 — 에이전트는 켜졌지만 우리 도구 연결이 «아직» 붙지 않음(단정 X · 유나 v13). 뜨는 때와 걷히는 때는
 * setupProgress(사람 입력 + 30초 · 받은 것을 본 때 + 180초 — PO 12:25Z). 연결이 뒤늦게 붙으면 단계로 돌아간다.
 */
export function ToolsNotConnected({ onRetry, claude }: { onRetry: () => void; claude: boolean }) {
  const t = useTranslations('desktop.setup');
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <h2 className="text-base font-semibold">{t('notConnected.title')}</h2>
      {/* Yuna v24 · PO 11:19Z: the trust question is Claude Code's — its sentence only when this setup has a Claude Code agent */}
      <p className="text-sm text-muted-foreground">{t(claude ? 'notConnected.bodyClaude' : 'notConnected.bodyOther')}</p>
      <div><Button onClick={onRetry}>{t('notConnected.action')}</Button></div>
    </Card>
  );
}

/**
 * 주소의 `#` 뒤에서 설정 값을 읽고 곧바로 주소에서 지운다(코드는 어떤 URL에도 남기지 않는다 — PO 09:45Z). 값은 이 컴포넌트의
 * 메모리에만 있다. 로그인을 거쳐 `#` 없이 돌아오면 데스크톱 앱이 값을 붙여 다시 연다(PO 09:58Z) — 웹은 맡아 두지 않는다.
 */
/** `#progress=<setup id>` — the reload from «설정을 마쳤어요» (4429 ①): the setup id only, never a code. */
export function progressFromFragment(hash: string): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, '')).get('progress') ?? '';
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

/** After that reload: renew the token first (a new page load may get it now), then the progress — or the same card again. */
function ResumeProgress({ setupId }: { setupId: string }) {
  const t = useTranslations('desktop.setup');
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { let off = false; void renewToken().then((r) => { if (!off) setOk(r); }); return () => { off = true; }; }, []);
  // named like the page's other loading card, so a screen reader is not silent (Yuna 10:02Z)
  if (ok === null) return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  return ok ? <SetupProgressView setupId={setupId} recipeName="" /> : <SetupDoneReload setupId={setupId} />;
}

export function DesktopSetupEntry() {
  const [entry, setEntry] = useState<{ query: SetupQuery | null; progress?: string | null } | null>(null);
  const searchParams = useSearchParams();
  const strip = () => window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  useEffect(() => {
    const hash = window.location.hash;
    const query = parseSetupFragment(hash);
    const progress = query ? null : progressFromFragment(hash);
    // off the address at once; the state change follows on the next microtask (no cascading render inside the effect)
    if (hash) strip();
    void Promise.resolve().then(() => setEntry({ query, progress }));
    // The values can also arrive AFTER this page is up: after an email login the desktop app reopens the same page with its `#`,
    // and that is a same-document fragment change, not a new load (dev 실측 15:24Z — the page showed «데스크톱 앱에서 열어 주세요»).
    // A newer code replaces an older one (the app restarted the setup).
    const onHash = () => {
      const q = parseSetupFragment(window.location.hash);
      const progress = q ? null : progressFromFragment(window.location.hash);
      if (!q && !progress) return;
      strip();
      setEntry({ query: q, progress });
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // The dashboard shell adds `?p=` with a router replace; the setup `#` came back with it in the dev run (15:31Z). Whenever the
  // query changes, take the setup values off the address again (they are already in memory).
  useEffect(() => {
    if (hasSetupFragment(window.location.hash)) strip();
  }, [searchParams]);
  if (!entry) return null;
  if (!entry.query && entry.progress) return <ResumeProgress setupId={entry.progress} />;
  return entry.query ? <SetupOrProgress key={entry.query.code} query={entry.query} /> : <OpenInDesktopApp />;
}

/** A setup id the server can hold (the same shape the /api/desktop/setups/{id} route lets through). */
const SETUP_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * story 4492 AC3 (PO 09:23Z (가)): the page opened with a code whose setup was already started (the app reopens it after
 * «오늘로 가기» · back · a reload) shows that setup's progress, not the form again — whichever way it was reached. Asked once
 * before anything is drawn: 200 (a confirmed setup is in this organization) → the progress, and the address becomes
 * `#progress=<id>` so a reload keeps it; anything else (404 not confirmed · another account's · offline · 5xx) → the form as
 * before (a «시작» there is the server's same-person replay or its refusal — nothing new is made). The loading card stays until
 * the answer: no form drawn first, so no «시작» to press in between.
 */
function SetupOrProgress({ query }: { query: SetupQuery }) {
  const t = useTranslations('desktop.setup');
  const id = query.setupId && SETUP_ID_SHAPE.test(query.setupId) ? query.setupId : null;
  const [started, setStarted] = useState<boolean | null>(id ? null : false);
  useEffect(() => {
    if (!id) return;
    let off = false;
    void fetchWithAuth(`/api/desktop/setups/${id}`)
      .then((res) => res.ok)
      .catch(() => false)
      .then((ok) => {
        if (off) return;
        // replaceState, not `location.hash =`: no hashchange for the page's own handler (same as 4429 ②)
        if (ok) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + PROGRESS_FRAGMENT(id));
        setStarted(ok);
      });
    return () => { off = true; };
  }, [id]);
  if (started === null) return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (started && id) return <SetupProgressView setupId={id} recipeName="" />;
  return <DesktopSetup code={query.code} runtimes={query.runtimes} blocked={query.blocked} setupId={query.setupId} />;
}

/** 코드 없이 브라우저로 직접 온 경우(AC5). */
export function OpenInDesktopApp() {
  const t = useTranslations('desktop.setup');
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">{t('direct.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('direct.body')}</p>
      <div><Button asChild><a href={SETUP_APP_LINK}>{t('direct.action')}</a></Button></div>
    </Card>
  );
}

/** 레시피 카드 아래 줄 «역할 {n} · {역할 목록}»(유나 표). */
function RecipeRolesLine({ recipe, runtimes }: { recipe: SetupRecipe; runtimes: DesktopRuntime[] }) {
  const t = useTranslations('desktop.setup');
  const tOrg = useTranslations('organization');
  // the same order as the rows below and the recipe gallery (orderedRecipeRoles — one order per recipe · Yuna 12:49Z)
  const roles = setupRoleRows(recipe, runtimes).map((r) => stageRoleLabel(r.role, tOrg));
  if (roles.length === 0) return null;
  return <span className="block text-xs text-muted-foreground">{t('recipeRoles', { n: roles.length, roles: roles.join(' · ') })}</span>;
}
