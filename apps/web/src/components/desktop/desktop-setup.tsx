'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Loader2, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fetchWithAuth } from '@/lib/db/client';
import { presetDescription, presetName } from '@/lib/platform-preset-copy';
import { pickEulReulJosa, pickEunNeunJosa, pickEuroJosa, pickIGaJosa } from '@/lib/korean-particle';
import { useFlatHref } from '@/hooks/use-flat-href';
import { stageRoleLabel } from '@/lib/stage-role';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { SetupProgressView } from './desktop-setup-progress';
import { DesktopSetupAgent, DesktopSetupQuick } from './desktop-setup-quick';
import { showsQuickCard } from '@/lib/desktop-setup-quick';
import { defaultOrgName } from '@/lib/default-org-name';
import { InviteCheckFailedCard } from './invite-check-failed';
import { formatLocaleDate } from '@/lib/i18n';
import { InvisibleSample, useViewerTimeZone } from '@/components/viewer-time-zone';
import { EmailVerifyGateCard, useEmailVerifyGate } from '@/components/auth/email-verify-gate';
import {
  agentRoomOf, agentRowCount, confirmBody, firstProjectConfirmBody, newOrgConfirmBody, setupFragment, hasSetupFragment, listableRecipe, parseSetupFragment, rememberActiveSetup, type OldRuntime, type SetupQuery, defaultWorkdirHint, needsAnAgent, setupRoleRows, workdirInputOk, withPreselectedAgent,
  type AgentRoom, type AttachableAgent, type DesktopRuntime, roomShort, type PreselectHold, type SetupRecipe, type SetupRoleRow, movedRowCount, ownerKey, preselectHoldOf, withAttachable, withDefaultRecipeFirst,
  addAgentTool, hasSignInCheck, JUDGED_AGENT_TOOLS,
  moveConfirmBody, movableState, moveListOrder } from '@/lib/desktop-setup';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { appSetupLink, nativeReturnApp, RETURN_APP_PARAM } from '@/lib/auth/native-return-app';
import { putOrgRemoteControl, useOrgRemoteControl } from '@/lib/org-remote-control';
import { agentLimitOf, type AgentLimit } from '@/lib/agent-limit';
import { isEEEnabled } from '@/lib/ee';
import { limitCopy } from '@/lib/plan-limit-copy';
import { CreateOrganizationDialog } from '@/components/nav/create-organization-dialog';
import { memberCardFacts } from '@/lib/desktop-setup-member';
import { TAB_PROJECT_STORAGE_KEY } from '@/lib/project-context-client';

/**
 * story #4427(E-DESKTOP P2) — 웹 설정 페이지. 데스크톱 앱이 이 페이지를 설정 코드 + 찾은 에이전트 목록과 함께 연다.
 * 모든 고를 것이 기본값으로 채워진 채 열리고 사람은 «시작» 한 번만 누른다(유나 시안 v3 · 사람 손 ≤ 3).
 * 실패는 «무엇이 · 왜 · 할 일 하나»(빨강 X · 설명 링크 0 · 요금제 말 0). 앱을 부르는 단추는 `ai.sprintable:/desktop/setup`
 * 링크로만(웹 쪽 preload 0 — 셸이 그 링크를 받아 새 코드로 다시 연다).
 */
export const SETUP_APP_LINK = appSetupLink(null);
/** story 4504 AC2 (PO 14:47Z): «앱 열기» on the page that came without values — «take me back to my setup», not «start another».
 * The app opens the setup it already launched for the same account (a new one for another account); every other button keeps
 * SETUP_APP_LINK (a new setup), the disconnected card's «앱에서 다시 시작» among them. Only the web knows which button it was. */
export const SETUP_REOPEN_LINK = appSetupLink(null, 'reopen');

/** story #4626: the links for the app that opened this page — `?app=` through the closed table (none · anything else = the
 *  default above, byte for byte; a typed address has none) */
export function useAppSetupLinks(): { open: string; reopen: string } {
  const app = nativeReturnApp(useSearchParams()?.get(RETURN_APP_PARAM));
  return { open: appSetupLink(app), reopen: appSetupLink(app, 'reopen') };
}
export const RUNTIME_LABEL: Record<DesktopRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };
// each provider's recommended install (no Node.js needed; fixed provider addresses with no version in them — PO 13:10Z from
// code.claude.com/docs/en/setup and github.com/openai/codex)
export const INSTALL: Record<DesktopRuntime, string> = { claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' };

export type SetupFailure = 'no-agent' | 'not-admin' | 'agent-limit' | 'expired' | 'offline' | 'managed' | 'no-recipe' | 'recipes-offline' | 'recipe-too-big' | 'recipes-changed' | 'has-org' | 'disconnected'
  // story #4576 — the move's own refusals (Yuna «② 확인이 거절될 때»)
  | 'move-not-admin' | 'move-changed' | 'move-offline';

/** 실패 화면 문구 키 — `Record<string, string>` 리터럴 표(키 가드가 이 모양의 값을 «읽힘»으로 센다). */
const FAILURE_KEY: Record<string, string> = {
  'no-agent.title': 'failure.no-agent.title', 'no-agent.body': 'failure.no-agent.body', 'no-agent.action': 'failure.no-agent.action',
  'not-admin.title': 'failure.not-admin.title', 'not-admin.body': 'failure.not-admin.body', 'not-admin.action': 'failure.not-admin.action',
  'agent-limit.body': 'failure.agent-limit.body', 'agent-limit.action': 'failure.agent-limit.action',
  'expired.title': 'failure.expired.title', 'expired.body': 'failure.expired.body', 'expired.action': 'failure.expired.action',
  'offline.title': 'failure.offline.title', 'offline.body': 'failure.offline.body', 'offline.action': 'failure.offline.action',
  'managed.title': 'failure.managed.title', 'managed.body': 'failure.managed.body', 'managed.action': 'failure.managed.action',
  'no-recipe.title': 'failure.no-recipe.title', 'no-recipe.body': 'failure.no-recipe.body', 'no-recipe.action': 'failure.no-recipe.action',
  'recipes-offline.title': 'failure.recipes-offline.title', 'recipes-offline.body': 'failure.recipes-offline.body', 'recipes-offline.action': 'failure.recipes-offline.action',
  // the button is ③'s «레시피 다시 고르기» (Yuna v20: the same action, the same words)
  'recipes-changed.title': 'failure.recipes-changed.title', 'recipes-changed.body': 'failure.recipes-changed.body', 'recipes-changed.action': 'failure.recipes-changed.action',
  'recipe-too-big.title': 'failure.recipe-too-big.title', 'recipe-too-big.body': 'failure.recipe-too-big.body', 'recipe-too-big.action': 'failure.agent-limit.action',
  'has-org.title': 'failure.has-org.title', 'has-org.body': 'failure.has-org.body', 'has-org.action': 'failure.has-org.action',
  // story 4498 (Yuna 10:51Z): the button is the same way back as the expired card's. story 4669 (Yuna A-5): its own words —
  // the expired card now says «새 코드로 다시», which is false here (this device's setup ended; it is not a code that ran out)
  'disconnected.title': 'failure.disconnected.title', 'disconnected.body': 'failure.disconnected.body', 'disconnected.action': 'failure.disconnected.action',
  // story #4576 (Yuna «② 확인이 거절될 때»): the not-admin card's button stays its «다시 확인» · the offline card keeps its title and button
  'move-not-admin.title': 'move.failureNotAdminTitle', 'move-not-admin.body': 'move.failureNotAdminBody', 'move-not-admin.action': 'failure.not-admin.action',
  'move-changed.title': 'move.failureChangedTitle', 'move-changed.body': 'move.failureChangedBody', 'move-changed.action': 'move.failureChangedAction',
  'move-offline.title': 'failure.offline.title', 'move-offline.body': 'move.failureOfflineBody', 'move-offline.action': 'failure.offline.action',
};

/** story #4576 — a move's confirm refusals (closed list · Mirko 04:31Z): the ones with their own card; every other code (a new-agent
 * or «me» row · the same agent twice · an app that cannot move — this page never sends those) → null, the one-line generic text. */
export function moveFailureForCode(code: string | undefined): SetupFailure | null {
  switch (code) {
    case 'not_org_admin':
    case 'person_session_required':
      return 'move-not-admin';
    // chosen, then stopped · removed · moved to another organization (404), or taken out of the project (422): the list again
    case 'agent_not_found':
    case 'agent_not_in_project':
      return 'move-changed';
    case 'code_expired':
    case 'code_used':
      return 'expired';
    default:
      return null;
  }
}

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
export async function joinNewOrg(body: { project_id?: string; data?: { project_id?: string } } | null): Promise<boolean> {
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

/** The person's pending invites (`GET /api/invites/mine`); throws when the list cannot be read — not knowing is not «no invites».
 *  One reading for the recipe setup and the first-setup card (story 4711). */
export async function fetchMyInvites(): Promise<MyInvite[]> {
  const res = await fetchWithAuth('/api/invites/mine');
  if (!res.ok) throw new Error(String(res.status));
  const body = await res.json();
  const list: unknown = body?.invites ?? body?.data?.invites;
  if (!Array.isArray(list)) throw new Error('no list');
  return list as MyInvite[];
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
  | { kind: 'failed'; failure: SetupFailure; counts?: LimitCounts | null; plan?: AgentLimit | null; retry?: 'load' | 'confirm' }
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
type OrgMode = { kind: 'has-org' } | { kind: 'checking' } | { kind: 'new' } | { kind: 'invited'; invites: MyInvite[] } | { kind: 'invite-failed' };

export function DesktopSetup({ code, runtimes: found, blocked = [], setupId = null, old = [], canMove = false, preselect = null }: { code: string; runtimes: DesktopRuntime[]; blocked?: DesktopRuntime[]; setupId?: string | null; old?: OldRuntime[]; canMove?: boolean; /** story 4680: the agent the recruiter just made — chosen for the first agent row once the list has it */ preselect?: string | null }) {
  // ⑥ 갈래 가: 찾았지만 회사 설정으로 도구를 못 붙이는 런타임은 고를 수 없고, 꺼진 선택지로만 보인다. PO 08:37Z · 유나 08:38Z.
  const runtimes = useMemo(() => found.filter((r) => !blocked.includes(r)), [found, blocked]);
  const claudeBlocked = blocked.includes('claude');
  const t = useTranslations('desktop.setup');
  const tPreset = useTranslations('recipePreset');
  const tOrg = useTranslations('organization');
  const tNewOrg = useTranslations('desktopOnboarding');
  const tOnboarding = useTranslations('onboarding');
  const { projectId, userName, orgId, orgMemberships, projectMemberships } = useDashboardContext();
  const [orgMode, setOrgMode] = useState<OrgMode>(() => (orgId ? { kind: 'has-org' } : { kind: 'checking' }));
  const newOrg = orgMode.kind === 'new';
  // story 4496 (PO 09:32Z (가)): the tab has no project. An admin's list is the organization's every project (`/me/memberships`
  // · owner/admin = the whole organization), so: none → the setup makes the first one; one → that one; more → the person picks.
  // The server counts again and makes a project only when there is none (409 project_required otherwise).
  const orgProjects = useMemo(() => (projectMemberships ?? []).filter((m) => !m.orgId || m.orgId === orgId), [projectMemberships, orgId]);
  const firstProject = orgMode.kind === 'has-org' && !projectId && orgProjects.length === 0;
  const [pickedProject, setPickedProject] = useState('');
  const chosenProject = projectId ?? (orgProjects.length === 1 ? orgProjects[0].projectId : (pickedProject || undefined));
  const [editingProjectName, setEditingProjectName] = useState(false);
  const needsProjectPick = orgMode.kind === 'has-org' && !projectId && orgProjects.length > 1 && !pickedProject;
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
  // story 4670 (U2 · AC1): «폰에서도 다루기» — one tick above «시작», on by default, only for the person who can switch the org's remote
  // control and only while it is off (a new organization: its maker is the owner-to-be, so always). The org's value is read the way
  // every page reads it (one reading · `useOrgRemoteControl`); not read (null) → no row. The PUT is sent only after the confirmation
  // succeeded and only if the tick is still on — it never rides on anything else (Kadir's lens 10-14 ⓒ).
  // story 4670 AC1 (Yuna §M): a read that FAILED draws the row too — unticked: an organization's value that could not be read is never
  // flipped to «on» by default (one that is on already loses nothing; one turned off on purpose stays off unless the person ticks)
  const [remoteState, , remoteReadFailed] = useOrgRemoteControl(orgId);
  const [phoneControlPicked, setPhoneControl] = useState<boolean | null>(null);
  const phoneControl = phoneControlPicked ?? !remoteReadFailed;
  const [phoneControlFailed, setPhoneControlFailed] = useState(false);
  const [recipes, setRecipes] = useState<SetupRecipe[]>([]);
  // story 4717 AC1: how many more agents the plan has room for (null = no limit holds · not read) — read with the recipe list
  const [agentRoom, setAgentRoom] = useState<AgentRoom | null>(null);
  const [recipeId, setRecipeId] = useState<string>('');
  const [rows, setRows] = useState<SetupRoleRow[]>([]);
  // story #4565: this org's existing agents the setup may move to this computer (owner/admin · this project) — none: no group
  const [attachable, setAttachable] = useState<AttachableAgent[]>([]);
  // story 4680 (Kadir 5065 · codex round 2): the recipes and the agent list are both read at mount, in either order. The recipe
  // read's `pick(usable[0])` closes over the mount render, where `attachable` is still [] — so it reads the list through a ref
  // (what has arrived by then). The preselect is never marked spent on «this list would land» — with no rows yet that spent it
  // on nothing and the recipe's rows came up without it.
  const attachableRef = useRef<readonly AttachableAgent[]>([]);
  // story 4701: which read of that list has ended — «<project>:<tick>» and how (ok / failed). The recruiter's agent (`agent=` · preselect)
  // can only land on a row once the list is here, so «시작» waits for it (a press before it made a NEW Creator · Publisher and left the
  // recruited agent on no setup). Derived from the key, not a flag set in the effect: the first render after a project / tick change is
  // «reading» too, so there is no frame with «시작» on.
  const [attachableRead, setAttachableRead] = useState<{ key: string; ok: boolean } | null>(null);
  // Yuna 4701-copy-1015 §2: after [목록 다시 불러오기] the button stays (aria-disabled while it reads, so focus stays on it); once the list is
  // here it goes and focus moves to «시작»
  const [attachableRetried, setAttachableRetried] = useState(false);
  // story 4703: the person let the recruiter's agent go — [새로 만들기로 바꾸기], or any row set by hand (setOwner). From then on no reason line
  // holds «시작» for it (and the preselect is spent: it never lands after this)
  const [preselectLetGo, setPreselectLetGo] = useState(false);
  const startFocusAfter = useRef(false);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const [workdir, setWorkdir] = useState('');
  const [editingDir, setEditingDir] = useState(false);
  const [pickingRecipe, setPickingRecipe] = useState(false); // 4446: the recipe list is folded to the chosen one until [바꾸기]
  // keyboard focus follows the fold (Yuna 00:54Z): opening puts it on the chosen recipe, folding puts it back on [바꾸기].
  // [바꾸기] stays in its place while the list is open (Qadir 4869: a disclosure whose button exists only while folded says
  // «collapsed» forever and controls a list that never exists) — it shows the state and folds the list again.
  const recipeListRef = useRef<HTMLDivElement | null>(null);
  const recipeChangeRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterFold = useRef<'list' | 'change' | null>(null);
  // story 4504 AC4: a press on a card's text moves focus off the radio before the click arrives (a label's text is not
  // focusable) — that blur must not fold the list, or the click lands on nothing and the choice never changes
  const pressInList = useRef(false);
  /** story 4516: the recipe card (its label) an event's target is in, or null — a click on it reaches its radio. */
  const recipeCardOf = (t: EventTarget | null) => (t instanceof Element ? t.closest('label') : null);
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
  // story #4576 — «레시피로 시작» (default: moving stops the agent wherever it worked, so only when a person chooses it) or
  // «이미 있는 에이전트 옮기기»; the agents ticked for the move (none by default — the same reason)
  const [setupKind, setSetupKind] = useState<'recipe' | 'move'>('recipe');
  const [moving, setMoving] = useState<string[]>([]);

  // 로그인이 필요했던 설정이면 한 번(4426 · 사람 손 셈) — 설정 id가 없으면 이 흐름에 묶을 수 없어 보내지 않는다
  useEffect(() => {
    if (!setupId) return;
    rememberActiveSetup(setupId); // 이 탭에서 문서를 열면 desktop_doc_opened로 셈(DesktopSetupDocWatch)
  }, [setupId]);

  // (나) no organization: their invites decide the mode (0 → a new organization · some → where to go · unreadable → (가))
  const inviteReads = useRef(0); // codex self-QA: only the LATEST read decides (a late failure must not overwrite a read that already succeeded)
  async function readInvites() {
    const mine = ++inviteReads.current;
    try {
      const list = await fetchMyInvites();
      if (mine !== inviteReads.current) return;
      setOrgMode(list.length ? { kind: 'invited', invites: list } : { kind: 'new' });
    } catch {
      if (mine !== inviteReads.current) return;
      setOrgMode({ kind: 'invite-failed' }); // story 4711 AC4: not knowing is not "no invites" — the page says so and reads again (no organization is made meanwhile)
    }
  }
  useEffect(() => {
    if (!orgId) void readInvites();
  }, [orgId]);

  // (나) the new organization's names: the same defaults as the one-screen «조직 만들기» (4832) — «{표시 이름}의 조직» (40 at most)
  // or «내 조직», never the e-mail; «첫 프로젝트». The display name comes from /api/auth/me; a name already typed is kept.
  useEffect(() => {
    if (firstProject) setProjectName((n) => n || tNewOrg('defaultProjectName'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstProject]);
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
        setAgentRoom(agentRoomOf(body?.agent_room)); // the contract's one shape (no data-wrapped fallback — scripts/verify_web_api_response_shapes.py)
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

  // story #4576: «목록 다시 불러오기» after a move was refused because the agents changed reads them again
  const [attachableTick, setAttachableTick] = useState(0);
  /** story 4680 (PO 5065 ②): the preselect is spent the first time it lands on a row, or the first time a person sets any row —
   * after that the rows are never written over (a recipe change · the list read again · a list that arrives after the person
   * acted). The flag is read and written OUTSIDE setRows updaters (an updater may run twice; it stays pure — PO 6e245cf40 (가)). */
  const preselectSpent = useRef(false);
  /** whether `agentId` would land on a row of this list (the same rule as existingChoices · withPreselectedAgent) */
  const preselectLands = (list: readonly AttachableAgent[]) =>
    !!preselect && list.some((a) => a.id === preselect && a.in_project && runtimes.includes(a.runtime));
  // «spent» = a person set a row (setOwner). Landing itself needs no mark: withPreselectedAgent is idempotent (the first agent row,
  // the same agent), so a rebuild before anyone touched a row lands the same thing — and with no rows yet nothing is lost.
  /** the agents list arrived — the first read · «목록 다시 불러오기» (4576) · after a [프로젝트 팀에 넣기] (4678): rows and ticks follow it */
  const applyAttachable = (list: AttachableAgent[]) => {
    attachableRef.current = list;
    setAttachable(list);
    // Kadir 4969 (2선): ticks follow the fresh list — an agent that dropped out is untied, never ticked again by itself
    setMoving((ms) => ms.filter((id) => list.some((a) => a.id === id && movableState(a, runtimes) === 'ok')));
    // story 4680: the recruiter's agent (`agent=` in the address) takes the first agent row once it is among the choices — once
    // (PO 5065 ②): the list is read again on «목록 다시 불러오기» (4576 · move mode) and a recipe change rebuilds the rows; a
    // person's own choice after that is never written over. Whether to apply is decided here (the updater stays pure); a
    // recruiter's agent that was not on the team lands here once [프로젝트 팀에 넣기] has made it so (PO 4678: the recruit path's
    // promise — the «자동 선택 안 함» of a put-on-team is for every other agent).
    const apply = !preselectSpent.current && preselectLands(list);
    setRows((rs) => (apply ? withPreselectedAgent(withAttachable(rs, list, runtimes), preselect) : withAttachable(rs, list, runtimes)));
  };
  // story #4565 — the «이미 있는 에이전트» group: read once the project is known (a new organization has none to move)
  useEffect(() => {
    if (orgMode.kind !== 'has-org' || !chosenProject || !isAdmin) { attachableRef.current = []; setAttachable([]); return; }
    let off = false;
    const readKey = `${chosenProject}:${attachableTick}`;
    // story 4701 (Yuna 4701-copy-1015 §3): a read that never answers is a silent failure — after the limit the page says «failed» (the
    // button reads again); an answer that comes after that still lands (the list is applied and «시작» turns on)
    const limit = setTimeout(() => { if (!off) setAttachableRead((cur) => (cur?.key === readKey ? cur : { key: readKey, ok: false })); }, ATTACHABLE_READ_LIMIT_MS);
    fetchWithAuth(`/api/desktop/setup/agents?project_id=${encodeURIComponent(chosenProject)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { agents?: AttachableAgent[] } | null) => {
        if (off) return;
        // the contract's one shape ({agents}) — anything else draws no group (never guessed from another field)
        applyAttachable(Array.isArray(body?.agents) ? body.agents : []);
        setAttachableRead({ key: readKey, ok: body !== null });
      })
      .catch(() => { if (!off) { attachableRef.current = []; setAttachable([]); setAttachableRead({ key: readKey, ok: false }); } })
      .finally(() => clearTimeout(limit)); // the group is left out — «새로 만들기» still works (no preselect: as before; with one «시작» waits — story 4701)
    return () => { off = true; clearTimeout(limit); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgMode.kind, chosenProject, isAdmin, attachableTick]);

  // story 4701: with the recruiter's agent in the address (`agent=`), «시작» waits for the agents list this page reads (the same condition
  // the read runs on). Still reading → «reading»; the read failed → «failed» (never a quiet fall to «새로 만들기»: [다시 불러오기] reads
  // again). No `agent=` · no read to wait for (a new organization · not an admin · no project yet) → nothing waits — the road as before.
  const appLinks = useAppSetupLinks();
  const attachableReadKey = chosenProject ? `${chosenProject}:${attachableTick}` : null;
  const attachableWanted = !!preselect && orgMode.kind === 'has-org' && !!chosenProject && isAdmin;
  const attachableHold: 'reading' | 'failed' | null = !attachableWanted ? null
    : attachableRead?.key !== attachableReadKey ? 'reading'
      : attachableRead.ok ? null : 'failed';
  // story 4703: why the recruiter's agent did not land although the list is here (Yuna 4703-copy-1015) — null while it is read, when the
  // person let it go, or when it lands. «시작» is off while a reason shows; a reason is never a quiet fall to a new agent.
  const preselectHold: PreselectHold | null = attachableWanted && attachableHold === null && !preselectLetGo
    ? preselectHoldOf(attachable, preselect, runtimes, blocked) : null;
  // «시작» when it is on; else the first agent row's role select — so focus never falls to the page (Yuna 4701 non-blocking ② · 4703 §②)
  const focusStartOrRoles = () => {
    const b = startRef.current;
    if (b && !b.disabled) b.focus(); else rolesRef.current?.querySelector<HTMLElement>('select')?.focus();
  };
  // the list arrived after [목록 다시 불러오기] (its button went away) → focus «시작», now on, with the recruiter's agent already chosen —
  // or, when «시작» is still off for another reason, the first agent row's role select
  useEffect(() => {
    if (attachableRetried && attachableHold === null) { setAttachableRetried(false); focusStartOrRoles(); }
  }, [attachableRetried, attachableHold]);
  // [새로 만들기로 바꾸기]: the reason line goes, the count line returns, focus moves to «시작»
  useEffect(() => {
    if (startFocusAfter.current && preselectHold === null) { startFocusAfter.current = false; focusStartOrRoles(); }
  }, [preselectHold]);

  function pick(r: SetupRecipe) {
    setRecipeId(r.id);
    // the list that has arrived by now — not the one this closure saw (the recipe read calls pick() from the mount render)
    const list = attachableRef.current;
    const built = withAttachable(setupRoleRows(r, runtimes), list, runtimes);
    const apply = !preselectSpent.current && preselectLands(list);
    setRows(apply ? withPreselectedAgent(built, preselect) : built);
    setWorkdir(defaultWorkdirHint(presetName(r, tPreset)));
    setEditingDir(false);
  }

  // story 4678 (P1′-a · Yuna §J): an agent the organization has that this project's team does not — [프로젝트 팀에 넣기] grants it
  // in place (POST /api/projects/{id}/access — the call the workforce page makes; this page is for org owners/admins, whom the
  // server lets in for every project), then the list is read again (the server is the truth). The setup code, the recipe and the
  // rows are not touched: one fetch, no navigation. 409 = already on the team = done.
  const [teamState, setTeamState] = useState<Record<string, 'busy' | 'failed'>>({});
  const [putDone, setPutDone] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const rolesRef = useRef<HTMLElement | null>(null);
  async function putOnTeam(a: AttachableAgent, order: readonly AttachableAgent[], fromHold = false) {
    if (!chosenProject || teamState[a.id] === 'busy') return;
    setTeamState((s) => ({ ...s, [a.id]: 'busy' }));
    setPutDone(null);
    const failed = () => { pendingFocus.current = fromHold ? 'hold-put' : `put:${a.id}`; setTeamState((s) => ({ ...s, [a.id]: 'failed' })); };
    try {
      const res = await fetchWithAuth(`/api/projects/${chosenProject}/access`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: a.id, org_member_id: null, permission: 'granted' }),
      });
      if (!res.ok && res.status !== 409) return failed();
      const again = await fetchWithAuth(`/api/desktop/setup/agents?project_id=${encodeURIComponent(chosenProject)}`);
      const body = again.ok ? await again.json() : null;
      if (!Array.isArray(body?.agents)) return failed(); // it is on the team now; pressing again reads 409 = done and reads the list
      // Yuna §J (필수): the pressed button goes away — focus goes to the next row's button, else where the agent can be picked
      const at = order.findIndex((x) => x.id === a.id);
      const next = order[at + 1] ?? order[at - 1];
      // story 4703 (Yuna §②): from the reason line, the agent lands on the first agent row — focus «시작» (or the row's select when it is still off)
      pendingFocus.current = fromHold ? 'start' : next ? `put:${next.id}` : moveMode ? `move:${a.id}` : 'select';
      applyAttachable(body.agents);
      setTeamState((s) => { const rest = { ...s }; delete rest[a.id]; return rest; });
      setPutDone(a.name);
    } catch {
      failed();
    }
  }
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === 'start') { focusStartOrRoles(); return; }
    const el = target === 'hold-put' ? document.querySelector<HTMLElement>('[data-preselect-put]')
      : target.startsWith('put:') ? document.querySelector<HTMLElement>(`[data-put-on-team="${target.slice(4)}"]`)
      : target.startsWith('move:') ? document.getElementById(`setup-move-${target.slice(5)}`)
        : rolesRef.current?.querySelector<HTMLElement>('select');
    el?.focus();
  }, [attachable, teamState]);

  const recipe = recipes.find((r) => r.id === recipeId);
  // story #4576 (Yuna): the two ways show only with an organization and at least one agent it could move — a way that cannot be
  // chosen is not shown (an app that cannot move is the exception: the way shows, turned off, with why and what to do)
  // Kadir 4969 ①: once a person chose «옮기기», the way stays even when the list comes back empty (reload · another project) — the
  // page never falls through to the recipe page with a recipe already chosen (one press would confirm a recipe)
  const showKinds = orgMode.kind === 'has-org' && (attachable.length > 0 || setupKind === 'move');
  const moveMode = showKinds && canMove && setupKind === 'move';
  // story 4670 AC1 (PO dev walk 10-15): the tick is for BOTH ways — the hire → «이 컴퓨터에서 시작» road lands on «옮기기» (the agent
  // just made is an «existing agent»), so a tick that left that way out left the usual new-customer road without it.
  const showPhoneControl = newOrg || (orgMode.kind === 'has-org' && (remoteReadFailed || (!!remoteState && remoteState.can_change && !remoteState.enabled)));
  const movable = useMemo(() => moveListOrder(attachable, runtimes), [attachable, runtimes]);
  // story 4678: the ones [프로젝트 팀에 넣기] can help — not on the team, and a runtime this computer has (without one, putting it on
  // the team would still leave it unusable: that is the line the move list gives instead)
  const outsiders = attachable.filter((a) => !a.in_project && runtimes.includes(a.runtime));
  const movableOutsiders = movable.filter((a) => !a.in_project && runtimes.includes(a.runtime));
  const moveChosen = moving.filter((id) => attachable.some((a) => a.id === id && movableState(a, runtimes) === 'ok'));
  const anyMovable = movable.some((a) => movableState(a, runtimes) === 'ok');
  const roleName = (role: string) => stageRoleLabel(role, tOrg);
  const humanRoles = useMemo(() => rows.filter((r) => r.owner.kind === 'me').map((r) => stageRoleLabel(r.role, tOrg)), [rows, tOrg]);
  const humanList = humanRoles.join(' · ');
  const agents = agentRowCount(rows);
  const moved = movedRowCount(rows);
  // story 4717 AC1: more new agents than the plan has room for — «시작» stays off and the ways show (never a 402 after the press)
  const short = !moveMode && roomShort(agentRoom, agents);
  const canUseExisting = rows.some((r) => r.owner.kind === 'agent' && r.choices.some((c) => c.kind === 'existing'));

  /**
   * story 4670 (AC1): the tick's one PUT — after the confirmation went through, for the org this setup belongs to (the one the server
   * just made, or this session's), and only while the row was drawn and still ticked. Both ways (a recipe start · a move) end here.
   * A failure never stops the setup — its line is at the progress head.
   */
  async function turnPhoneControlOn(phoneOrg: string | null | undefined) {
    if (!showPhoneControl || !phoneControl || !phoneOrg) return;
    const turned = await putOrgRemoteControl(phoneOrg);
    setPhoneControlFailed(!turned.ok);
  }

  async function start() {
    if (!recipe || (!newOrg && !firstProject && !chosenProject)) return;
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
          body: JSON.stringify(firstProject ? firstProjectConfirmBody(code, rows, recipe.id, workdir, projectName)
            : confirmBody(code, rows, chosenProject!, recipe.id, workdir)),
        });
      if (res.ok) {
        const okBody = await res.json().catch(() => null) as { project_id?: string; org_id?: string } | null;
        if (newOrg && !(await joinNewOrg(okBody))) { setView({ kind: 'done-reload' }); return; }
        // story 4496: the tab had no project — the one made (or the one used) becomes the tab's, the way the new organization's does
        if (!newOrg && !projectId) {
          if (!(await joinNewOrg({ project_id: okBody?.project_id ?? chosenProject }))) { setView({ kind: 'done-reload' }); return; }
        }
        // story 4670 (AC1): the confirmation went through → the tick's one PUT, for the org this setup belongs to: the one the server
        // just made (confirm-new-org's `org_id`) or this session's. A failure never stops the setup — its line is at the progress head.
        await turnPhoneControlOn(newOrg ? okBody?.org_id ?? null : orgId);
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
      // story 4496 (Yuna 09:32Z): the organization's project limit — for any plan, so no plan named
      if (firstProject && error?.code === 'PLAN_LIMIT_EXCEEDED' && error.resource === 'project') {
        setView({ kind: 'error', message: t('firstProject.limit', { limit }) });
        return;
      }
      const message = !newOrg ? null
        : error?.code === 'EMAIL_VERIFICATION_REQUIRED' ? tOnboarding('emailVerifyRequiredError')
        : error?.code === 'PLAN_LIMIT_EXCEEDED' && error.resource === 'org' ? tOnboarding('orgLimitExceededError', { limit })
        : error?.code === 'PLAN_LIMIT_EXCEEDED' && error.resource === 'project' ? tOnboarding('projectLimitExceededError', { limit })
        : null;
      if (message) { setView({ kind: 'error', message }); return; }
      const failure = failureForCode(error?.code, error?.resource);
      setView(failure ? { kind: 'failed', failure, counts: failure === 'agent-limit' ? limitCounts(body?.error) : null, plan: failure === 'agent-limit' ? agentLimitOf(402, body) : null, retry: failure === 'recipes-changed' ? 'load' : undefined } : { kind: 'error' });
    } catch {
      setView({ kind: 'failed', failure: 'offline', retry: 'confirm' });
    }
  }

  async function moveStart() {
    if (!chosenProject || moveChosen.length === 0) return;
    setRateLine(null);
    setView({ kind: 'starting' });
    try {
      const res = await fetchWithAuth('/api/desktop/setup-codes/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(moveConfirmBody(code, chosenProject, moveChosen)),
      });
      if (res.ok) {
        // the tab had no project: the one moved into becomes the tab's, as a recipe start does (story 4496)
        if (!projectId && !(await joinNewOrg({ project_id: chosenProject }))) { setView({ kind: 'done-reload' }); return; }
        await turnPhoneControlOn(orgId); // story 4670 AC1: the same tick, the same one PUT (a move is always this session's org)
        setView({ kind: 'started' });
        return;
      }
      const body = await res.json().catch(() => null);
      const error = body?.error as { code?: string } | undefined;
      if (res.status === 429 || error?.code === 'RATE_LIMITED') {
        const secs = Number(res.headers.get('Retry-After'));
        const time = !Number.isFinite(secs) || secs <= 0 ? t('rateLimitedMoment')
          : secs < 60 ? t('rateLimitedSeconds', { n: Math.ceil(secs) }) : t('rateLimitedMinutes', { n: Math.ceil(secs / 60) });
        setRateLine(t('rateLimited', { time }));
        setView({ kind: 'choose' });
        return;
      }
      const failure = moveFailureForCode(error?.code);
      setView(failure ? { kind: 'failed', failure, retry: failure === 'move-changed' ? 'load' : undefined } : { kind: 'error' });
    } catch {
      setView({ kind: 'failed', failure: 'move-offline', retry: 'confirm' });
    }
  }

  if (orgMode.kind === 'invite-failed') return <InviteCheckFailedCard onRetry={() => { setOrgMode({ kind: 'checking' }); void readInvites(); }} />;
  if (newOrg && verifyGate.kind === 'closed') return <EmailVerifyGateCard gate={verifyGate} />;
  if (newOrg && verifyGate.kind === 'reading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  // a person making a new organization is its owner-to-be: the server checks «no organization» itself (org_members 0 rows)
  // the setup values are only in memory (the page took them off the address): a reload that should land on THIS page puts them back first
  // — «이미 조직이 있어요» [다시 불러오기] (4429 ②) and, story 4721, the member card's [다시 확인] and its switch into the new organization
  const reloadKeepingSetup = () => {
    // replaceState, not `location.hash =`: no hashchange (the page's own handler would take the values off again before the reload)
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + setupFragment({ code, runtimes: found, setupId, blocked, old, ...(canMove ? { canMove: true as const } : {}), ...(preselect ? { agent: preselect } : {}) }));
    window.location.reload();
  };
  if (orgMode.kind === 'invited') return <InvitedInApp invites={orgMode.invites} onReload={reloadKeepingSetup} />;
  if (orgMode.kind === 'has-org' && !isAdmin && view.kind !== 'loading') return <Failure failure="not-admin" onReloadPage={reloadKeepingSetup} />;
  if (view.kind === 'loading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (view.kind === 'failed') {
    // «목록 다시 불러오기» (move-changed): the agents are read again — the ticks that are no longer movable fall off by themselves
    const onRetry = view.failure === 'move-changed' ? () => { setAttachableTick((n) => n + 1); reload(); }
      : view.retry === 'load' ? reload
      : view.failure === 'offline' ? () => void start() : view.failure === 'move-offline' ? () => void moveStart() : undefined;
    // «이미 조직이 있어요» [다시 불러오기]: reload with the setup values put back into the fragment — they are only in memory now
    // (the page took them off the address), and a bare reload showed «데스크톱 앱에서 열어 주세요» (4429 ②)
    const onReloadPage = view.failure === 'has-org' || view.failure === 'not-admin' ? reloadKeepingSetup : undefined;
    return <Failure failure={view.failure} counts={view.counts ?? null} plan={view.plan ?? null} onRetry={onRetry} onReloadPage={onReloadPage}
      onChooseRecipe={view.failure === 'agent-limit' || view.failure === 'recipe-too-big' ? () => setView({ kind: 'choose' }) : undefined} />;
  }
  // 쓸 수 있는 런타임이 하나도 없을 때: 막힌 것만 있으면 ⑥ 전체 화면, 아무것도 못 찾았으면 ①
  if (runtimes.length === 0 && needsAnAgent(rows)) {
    // story 4494 (Yuna 10:11Z ⓐ): nothing usable, but installed below the floor — say that, not «찾지 못했어요»
    return blocked.length === 0 && old.length > 0 ? <TooOldCard old={old} /> : <Failure failure={blocked.length > 0 ? 'managed' : 'no-agent'} />;
  }
  if (view.kind === 'done-reload') return <SetupDoneReload setupId={setupId} />;
  if (view.kind === 'started') return <SetupProgressView setupId={setupId} recipeName={recipe ? presetName(recipe, tPreset) : ''} phoneControlFailed={phoneControlFailed} />;

  const setOwner = (role: string, key: string) => {
    preselectSpent.current = true; // story 4680 (PO (나)): a person set a row — the recruiter's preselect never lands after this
    setPreselectLetGo(true); // story 4703: …and no reason line holds «시작» for it any more
    setRows((rs) => rs.map((r) => (r.role === role ? { ...r, owner: r.choices.find((c) => ownerKey(c) === key) ?? r.owner } : r)));
  };
  // agents found but every either row set to «나»: «시작» off with the reason in the count line's place (Yuna v21 — n = 0 there
  // would be false); the server refuses the same with no_agent_role
  const noAgentRow = needsAnAgent(rows);
  const namesOk = firstProject ? !!projectName.trim() : !newOrg || (!!orgName.trim() && !!projectName.trim());
  const canStart = !!recipe && (newOrg || firstProject || !!chosenProject) && namesOk && !noAgentRow && workdirInputOk(workdir) && view.kind === 'choose' && attachableHold === null && preselectHold === null && !short;
  const canMoveStart = !!chosenProject && moveChosen.length > 0 && view.kind === 'choose';
  const toggleMove = (id: string, on: boolean) => setMoving((ms) => (on ? [...new Set([...ms, id])] : ms.filter((m) => m !== id)));

  return (
    <Card className="break-keep flex flex-col gap-6 p-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')}</p>
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{moveMode ? t('move.lead') : t('lead')}</p>
      </header>

      {/* story #4576 (Yuna «4576 셋업 첫 고르기»): two ways, one radio group, cards shaped like the recipe cards — below the head,
          above the project pick. «옮기기» turned off (radio off · name muted · why in its description's place) when the app that
          opened this page did not say it can take a move (`caps=move`): hiding it would send the person to ①'s «이미 있는 에이전트»
          — the recipe applied again, the very path this card fixes */}
      {showKinds ? (
        <section aria-labelledby="setup-kind" data-testid="setup-kind">
          <h2 id="setup-kind" className="text-sm font-medium">{t('move.kindLabel')}</h2>
          <div role="radiogroup" aria-labelledby="setup-kind" className="mt-2 flex flex-col gap-2">
            <label className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary">
              {/* Kadir 4969 (2선): no switching while a start is on its way — an offline [다시 시도] must repeat what was sent */}
              <input type="radio" name="setup-kind" value="recipe" checked={!moveMode} disabled={view.kind === 'starting'} onChange={() => setSetupKind('recipe')} className="mt-1 shrink-0 self-start" />
              <span><span className="block text-sm font-medium">{t('move.kindRecipe')}</span>
                <span className="block text-xs text-muted-foreground">{t('move.kindRecipeDesc')}</span></span>
            </label>
            <label className={`flex gap-3 rounded-md border p-3 has-[:checked]:border-primary ${canMove ? 'cursor-pointer' : 'cursor-not-allowed'}`} data-testid="setup-kind-move" data-disabled={canMove ? undefined : 'true'}>
              <input type="radio" name="setup-kind" value="move" checked={moveMode} disabled={!canMove || view.kind === 'starting'} onChange={() => setSetupKind('move')} className="mt-1 shrink-0 self-start" />
              <span><span className={`block text-sm font-medium ${canMove ? '' : 'text-muted-foreground'}`}>{t('move.kindMove')}</span>
                <span className="block text-xs text-muted-foreground" data-testid={canMove ? undefined : 'setup-kind-move-why'}>{canMove ? t('move.kindMoveDesc') : t('move.kindMoveOldApp')}</span></span>
            </label>
          </div>
        </section>
      ) : null}

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

      {/* story 4496 (Yuna 09:32Z): the organization has no project yet — the setup makes the first one; the new organization's
          line and [바꾸기] in the same place */}
      {firstProject ? (
        <section aria-label={tNewOrg('projectLabel')} data-testid="setup-first-project">
          {editingProjectName ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm font-medium">{tNewOrg('projectLabel')}
                <Input value={projectName} maxLength={100} onChange={(e) => setProjectName(e.target.value)} />
                {!projectName.trim() ? <span className="text-xs font-normal text-muted-foreground">{tNewOrg('projectRequired')}</span> : null}
              </label>
              <p className="text-xs text-muted-foreground">{t('newOrg.later')}</p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md bg-muted p-3">
              <p className="min-w-0 text-sm">{t('firstProject.line', { name: projectName })}</p>
              <Button variant="ghost" size="sm" aria-label={t('firstProject.changeAria')} onClick={() => setEditingProjectName(true)}>{t('change')}</Button>
            </div>
          )}
        </section>
      ) : null}

      {/* story 4496 ⓑ: projects exist but the tab has none and there are several — the person picks one (none is made) */}
      {orgMode.kind === 'has-org' && !projectId && orgProjects.length > 1 ? (
        <label className="flex flex-col gap-1 text-sm font-medium" data-testid="setup-project-pick">{t('projectPick.label')}
          <select className="rounded-md border bg-background px-2 py-1 text-base font-normal lg:text-sm" value={pickedProject}
            // Kadir 4969 (2선): the old project's ticks never ride to the new one — cleared before its list comes
            onChange={(e) => { setMoving([]); setPickedProject(e.target.value); }}>
            <option value="" disabled>{t('projectPick.placeholder')}</option>
            {orgProjects.map((p) => <option key={p.projectId} value={p.projectId}>{p.projectName}</option>)}
          </select>
        </label>
      ) : null}

      {moveMode ? (
        // story #4576 ②: no recipe, roles or folder — one «옮길 에이전트» list (a tick each · several) · the found line kept under its
        // title (why a row cannot be ticked) · the movable ones first · none ticked by default
        <section aria-labelledby="setup-move-list" data-testid="setup-move-list">
          <h2 id="setup-move-list" className="text-sm font-medium">{t('move.listTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('found', { list: runtimes.map((r) => RUNTIME_LABEL[r]).join(' · ') || '—' })}</p>
          {movable.length === 0 ? (
            // Yuna 05:28Z: no agent of this organization to move at all — in the list's place, the same bordered box
            <p className="mt-2 rounded-md border p-3 text-sm text-muted-foreground" data-testid="setup-move-empty">{t('move.listEmpty')}</p>
          ) : (
          <ul className="mt-2 flex flex-col divide-y rounded-md border">
            {movable.map((a) => {
              const state = movableState(a, runtimes);
              const on = state === 'ok' && moving.includes(a.id);
              // move.rowNotInProject says the same as the select's existingNotInProject (4565) without the name — change one, change both
              // (kept two keys: the en select line starts lower-case after «{name} · »)
              // story 4678: «팀에 아직 없어요» is a line with a button next to it — only where the button can help; a missing runtime is the
              // blocker that stays whatever the team says
              const canPutOnTeam = state === 'not-in-project' && runtimes.includes(a.runtime);
              const second = canPutOnTeam ? t('move.rowNotInProject')
                : state === 'runtime-missing' || state === 'not-in-project' ? t('move.rowRuntimeMissing', { runtime: RUNTIME_LABEL[a.runtime], iGa: pickIGaJosa(RUNTIME_LABEL[a.runtime]) })
                  : t('onThisComputer', { runtime: RUNTIME_LABEL[a.runtime] });
              return (
                <li key={a.id} className="p-3" data-testid="setup-move-row" data-state={state}>
                  <div className="flex gap-3">
                    <input type="checkbox" id={`setup-move-${a.id}`} checked={on} disabled={state !== 'ok'} onChange={(e) => toggleMove(a.id, e.target.checked)} className="mt-1 shrink-0 self-start" />
                    <div className="min-w-0 break-keep">
                      <label htmlFor={`setup-move-${a.id}`} className={`block ${state === 'ok' ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                        <span className={`block text-sm font-medium ${state === 'ok' ? '' : 'text-muted-foreground'}`}>{a.name}</span>
                        <span className="block text-xs text-muted-foreground">{second}</span>
                      </label>
                      {/* the 4565 note under a ticked row only (same place, same words — under the name's column) */}
                      {on ? <MovedAgentNote agent={a} /> : null}
                      {canPutOnTeam ? <div className="mt-1"><PutOnTeamButton agent={a} state={teamState[a.id]} onPress={() => void putOnTeam(a, movableOutsiders)} /></div> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          )}
          {/* Yuna 05:39Z: with nothing to move the folder line says nothing true */}
          {anyMovable ? <p className="mt-2 text-xs text-muted-foreground">{t('move.folderNote')}</p> : null}
        </section>
      ) : (
        <>
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
                pressInList.current = false; // a key, not a press: an arrow's click only chooses
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                // a screen reader can put focus on a radio without choosing it: Enter/Space there chooses that one (PO 03:41Z)
                const el = e.target as HTMLInputElement;
                if (el.name === 'recipe' && !el.checked) { const r = recipes.find((x) => x.id === el.value); if (r) pick(r); }
                foldRecipes(true);
              }}
              onPointerDown={(down) => {
                pressInList.current = true;
                // story 4504 AC4 (live 2026-10-03): kept until the press's own click has run — a click on a card's text reaches its
                // radio only as the label's default action, after the event's listeners; the radio's click uses it and clears it,
                // and a key in the list clears it too. Story 4516: the press ends in one place — the mark stays only when its click
                // will reach a radio (released on the card it was pressed on); released anywhere else (between cards · on another
                // card · outside the list) or cancelled (a touch that became a scroll) there is no radio click to wait for, so it
                // is cleared at once.
                // Story 4516 (live 2026-10-03 · Min ①b): clearing alone is not enough — the press itself took focus off the radio (a
                // press between cards lands on the list, which takes no focus → body) and that blur was held for this press's click,
                // which will not come. With focus already out of the list no later blur can fold it, so the held blur is settled here:
                // released inside the list (or cancelled) → focus back on the chosen radio — pressing empty space chooses nothing and
                // folds nothing, and the next click outside or Tab folds it as usual; released outside the list → folded now, as a
                // click outside does.
                const card = recipeCardOf(down.target);
                const release = (up: PointerEvent) => {
                  window.removeEventListener('pointerup', release);
                  window.removeEventListener('pointercancel', release);
                  const list = recipeListRef.current;
                  if (up.type !== 'pointercancel' && card && recipeCardOf(up.target) === card && list?.contains(card)) return; // its radio click comes
                  pressInList.current = false;
                  if (!list || list.contains(document.activeElement)) return; // focus still in the list: its next blur folds as usual
                  if (up.type === 'pointercancel' || (up.target instanceof Node && list.contains(up.target))) {
                    // without scrolling: after a cancelled touch the person was scrolling the list — never pull it back (PO 06:26Z)
                    list.querySelector<HTMLInputElement>('input[name=recipe]:checked')?.focus({ preventScroll: true });
                  } else foldRecipes(document.hasFocus());
                };
                window.addEventListener('pointerup', release);
                window.addEventListener('pointercancel', release);
              }}
              onBlur={(e) => {
                if (pressInList.current) return; // a press inside the list: its click decides
                const to = e.relatedTarget as Node | null;
                if (e.currentTarget.contains(to) || to === recipeChangeRef.current) return; // [바꾸기]'s own click folds it
                foldRecipes(to === null && document.hasFocus());
              }}>
              {recipeOrder.map((id) => recipes.find((x) => x.id === id)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => (
                // story 4504 AC4 (live 2026-10-03 02:18Z): a person's click chooses, THEN folds — the fold is on the radio's own click
                // (after its change), never on the label's: a browser does the label's default action (that radio click) only after
                // the label's listeners and the update they flushed, so folding there removed the radio before it was chosen. A
                // press inside the list (pointer) folds; an arrow key's click (no press) only chooses.
                // story 4553: the radio keeps its own size in the flex label (no stretch to the card's height) — its focus ring is a ring,
                // not a card-tall capsule
                <label key={r.id} className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary">
                  <input type="radio" name="recipe" value={r.id} checked={r.id === recipeId} onChange={() => pick(r)} className="mt-1 shrink-0 self-start"
                    onClick={() => { if (pressInList.current) { pressInList.current = false; foldRecipes(true); } }} />
                  <span><span className="block text-sm font-medium">{presetName(r, tPreset)}</span>
                    {presetDescription(r, tPreset) ? <span className="block text-xs text-muted-foreground">{presetDescription(r, tPreset)}</span> : null}
                    <RecipeRolesLine recipe={r} runtimes={runtimes} /></span>
                </label>
              ))}
            </div>
          ) : null}
        </section>
  
        <section aria-labelledby="setup-roles" ref={rolesRef}>
          <h2 id="setup-roles" className="text-sm font-medium">{t('rolesTitle')}</h2>
          <p className="text-xs text-muted-foreground">{t('found', { list: runtimes.map((r) => RUNTIME_LABEL[r]).join(' · ') || '—' })}</p>
          {/* story 4494 (Yuna 10:11Z ⓑ): another runtime was found, this one is only below its floor — why it is not offered */}
          {old.map((o) => (
            <p key={o.runtime} className="text-xs text-muted-foreground" data-testid="setup-too-old-skipped">
              {t('tooOld.skipped', { runtime: RUNTIME_LABEL[o.runtime], josa: pickEunNeunJosa(RUNTIME_LABEL[o.runtime]), version: o.version, min: o.min })}
            </p>
          ))}
          <ul className="mt-2 flex flex-col divide-y rounded-md border">
            {rows.map((r) => (
              <li key={r.role} className="p-3">
                <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-keep">
                  <span className="block text-sm font-medium">{roleName(r.role)}</span>
                  <span className="block text-xs text-muted-foreground">{r.actor === 'human' ? t('whoHuman') : r.actor === 'either' ? t('whoEither') : t('whoAgent')}</span>
                </span>
                {r.choices.length === 1
                  ? <span className="text-sm">{r.owner.kind === 'me' ? t('me', { name: myName }) : r.owner.kind === 'existing' ? r.owner.name : t('onThisComputer', { runtime: RUNTIME_LABEL[r.owner.runtime] })}</span>
                  : (
                    <select aria-label={t('ownerFor', { role: roleName(r.role) })} className="max-w-[55%] shrink-0 rounded-md border bg-background px-2 py-1 text-base lg:text-sm"
                      value={ownerKey(r.owner)} onChange={(e) => setOwner(r.role, e.target.value)}>
                      {attachable.length === 0 ? (
                        <>
                          {r.choices.map((c) => <option key={ownerKey(c)} value={ownerKey(c)}>{c.kind === 'me' ? t('me', { name: myName }) : c.kind === 'existing' ? c.name : RUNTIME_LABEL[c.runtime]}</option>)}
                          {claudeBlocked && r.actor !== 'human' ? <option value="claude-blocked" disabled>{t('blockedClaudeOption')}</option> : null}
                        </>
                      ) : (
                        // story #4565 (Yuna 02:32Z ①): one select, three groups — new · existing agents · person
                        <>
                          <optgroup label={t('ownerGroupNew')}>
                            {r.choices.filter((c) => c.kind === 'agent').map((c) => <option key={ownerKey(c)} value={ownerKey(c)}>{c.kind === 'agent' ? RUNTIME_LABEL[c.runtime] : ''}</option>)}
                            {claudeBlocked ? <option value="claude-blocked" disabled>{t('blockedClaudeOption')}</option> : null}
                          </optgroup>
                          <optgroup label={t('ownerGroupExisting')}>
                            {attachable.filter((a) => a.in_project).map((a) => {
                              const key = `agent:${a.id}`;
                              const elsewhere = rows.some((o) => o.role !== r.role && o.owner.kind === 'existing' && o.owner.agentId === a.id);
                              const missing = !runtimes.includes(a.runtime);
                              // story 4678: an agent not on this project's team is not an option here (a disabled line cannot hold the
                              // button) — it is in the «프로젝트 팀에 없는 에이전트» list under the rows, with [프로젝트 팀에 넣기]
                              // story #4576: the reason is the move list's own line (one text, never two that overlap) after «{name} · »
                              const label = missing ? `${a.name} · ${t('move.rowRuntimeMissing', { runtime: RUNTIME_LABEL[a.runtime], iGa: pickIGaJosa(RUNTIME_LABEL[a.runtime]) })}`
                                : elsewhere ? t('existingPickedElsewhere', { name: a.name }) : a.name;
                              return <option key={key} value={key} disabled={missing || elsewhere}>{label}</option>;
                            })}
                          </optgroup>
                          {r.choices.some((c) => c.kind === 'me') ? (
                            <optgroup label={t('ownerGroupPerson')}>
                              <option value="me">{t('me', { name: myName })}</option>
                            </optgroup>
                          ) : null}
                        </>
                      )}
                    </select>
                  )}
                </div>
                {/* story #4565 (Yuna 02:32Z ② · 02:39Z): an existing agent with a live key — what moving it does, then when it was last seen */}
                {r.owner.kind === 'existing' ? <MovedAgentNote agent={attachable.find((a) => r.owner.kind === 'existing' && a.id === r.owner.agentId)} /> : null}
                {/* story 4653 (Yuna ⑤ design:pass): the CLIs this agent uses — under the owner select, one line */}
                {r.owner.kind === 'agent' || r.owner.kind === 'existing' ? (
                  <AgentToolsLine runtime={r.owner.runtime} tools={r.tools ?? []} onChange={(next) => setRows((rs) => rs.map((x) => (x.role === r.role ? { ...x, tools: next } : x)))} />
                ) : null}
              </li>
            ))}
          </ul>
          {/* story 4678 (Yuna §J): the organization's agents that are not on this project's team — one list, a button per line.
              AC3 (PO 2026-10-19 · Yuna's wheel: «넣기 → 고르기 → [시작]» = 3 hands, the folded list made it 4): OPEN from the start whenever there is at least one
              (zero → not drawn at all, as before). A person can still fold it; a re-render does not open it again (the prop never changes). */}
          {outsiders.length > 0 ? (
            <details open className="mt-2 rounded-md border" data-testid="setup-not-on-team">
              <summary className="cursor-pointer break-keep px-3 py-2 text-sm">{t('notOnTeamGroup', { n: outsiders.length })}</summary>
              <ul className="divide-y border-t">
                {outsiders.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 p-3" data-testid="setup-not-on-team-row">
                    <span className="min-w-0 break-keep text-sm">{t('existingNotInProject', { name: a.name })}</span>
                    <PutOnTeamButton agent={a} state={teamState[a.id]} onPress={() => void putOnTeam(a, outsiders)} />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p role="status" aria-live="polite" className="mt-2 break-keep text-xs text-foreground empty:hidden" data-testid="setup-put-on-team-done">
            {putDone ? t('putOnTeamDone', { name: putDone }) : null}
          </p>
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
  
        </>
      )}

      {/* what the agents ask and what they do not (PO 00:41Z · Yuna v17): Sprintable's own tools are pre-allowed; files ·
          commands · other tools follow the person's own Claude Code · Codex settings on that computer (story 4708 — the app no longer
          promises «ask each time») — at the end of the flow, just above the start row (4446) */}
      <p className="text-xs text-muted-foreground">{t('toolNote')}</p>

      {/* «시작» and its one line stay in sight (4446 · Yuna b2d15f85 ② · PO 00:31Z): stuck to the bottom of whatever scrolls —
          the window for a new organization, the app shell's main area for an existing one — on the card's own background, a thin
          line above. Spans the card's padding so it reads as the card's last row. */}
      <footer className="sticky bottom-0 -mx-6 -mb-6 flex flex-col gap-2 rounded-b-[inherit] border-t bg-card px-6 pt-3 pb-6" data-testid="setup-start-row">
        {showPhoneControl ? (
          // story 4670 AC1 (Yuna §M): a bordered box, the phone icon, a semibold label, a bigger tick — inside the sticky footer, just above «시작»
          <div className="flex gap-3 rounded-md border p-3" data-testid="setup-phone-control">
            <input type="checkbox" id="setup-phone-control" checked={phoneControl} onChange={(e) => setPhoneControl(e.target.checked)} disabled={view.kind === 'starting'} className="mt-0.5 size-5 shrink-0 self-start accent-primary" />
            <label htmlFor="setup-phone-control" className="block min-w-0 flex-1 cursor-pointer break-keep">
              <span className="flex items-center gap-1.5 text-sm font-semibold"><Smartphone className="size-4 shrink-0 text-primary" aria-hidden />{t('phoneControl.label')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t('phoneControl.help')}</span>
            </label>
          </div>
        ) : null}
        <Button ref={startRef} onClick={() => void (moveMode ? moveStart() : start())} disabled={moveMode ? !canMoveStart : !canStart}>
          {view.kind === 'starting' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{moveMode ? t('move.start') : t('start')}
        </Button>
        {/* story 4701 (Yuna 4701-copy-1015): the recruiter's agent is not on a row until the list is read — «시작» is off and says why, in the
            count line's place and before every other reason (the waiting IS the reason at that moment) */}
        {attachableHold !== null && !moveMode ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role={attachableHold === 'failed' ? 'alert' : 'status'} data-testid={attachableHold === 'failed' ? 'setup-attachable-failed' : 'setup-attachable-reading'}>
            {attachableHold === 'reading' ? <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden /> : null}
            {attachableHold === 'failed' ? t('attachableFailed') : t('attachableReading')}
          </p>
        ) : preselectHold !== null && !moveMode ? (
          // story 4703 (Yuna 4703-copy-1015): the list is here and the recruiter's agent cannot take a row — «시작» is off, the line says why
          // (from the list and the found runtimes — never a guess) and the way that keeps the agent comes before «새로 만들기로 바꾸기». The
          // line takes the count line's place; the only control that starts is still «시작».
          <div className="flex flex-col gap-2" data-testid="setup-preselect-hold">
            <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" role="status" data-testid="setup-preselect-reason" data-reason={preselectHold.reason}>
              {preselectHold.reason === 'unlisted' ? t('preselect.notListed')
                : preselectHold.reason === 'outside_project' ? t('preselect.notInProject', { name: preselectHold.agent.name })
                  : preselectHold.reason === 'runtime_missing'
                    ? t('preselect.runtimeMissing', { name: preselectHold.agent.name, runtime: RUNTIME_LABEL[preselectHold.agent.runtime], eulReul: pickEulReulJosa(RUNTIME_LABEL[preselectHold.agent.runtime]) })
                    : t('preselect.runtimeBlocked', { name: preselectHold.agent.name, runtime: RUNTIME_LABEL[preselectHold.agent.runtime], eunNeun: pickEunNeunJosa(RUNTIME_LABEL[preselectHold.agent.runtime]) })}
            </p>
            {preselectHold.reason === 'runtime_missing' ? (
              <div className="flex items-center justify-between gap-3 rounded-md border p-2" data-testid="setup-preselect-install">
                <code className="min-w-0 truncate text-xs">{INSTALL[preselectHold.agent.runtime]}</code>
                <Button
                  variant="ghost" size="sm" aria-label={t('failure.copyAria', { runtime: RUNTIME_LABEL[preselectHold.agent.runtime] })}
                  onClick={() => void navigator.clipboard?.writeText(INSTALL[preselectHold.agent.runtime]).catch(() => {})}
                >{t('failure.copy')}</Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {preselectHold.reason === 'outside_project' ? (
                <PutOnTeamButton agent={preselectHold.agent} state={teamState[preselectHold.agent.id]} onPress={() => void putOnTeam(preselectHold.agent, [preselectHold.agent], true)} fromHold />
              ) : null}
              {preselectHold.reason === 'runtime_missing' ? (
                <Button asChild variant="outline" size="sm" data-testid="setup-preselect-look-again"><a href={appLinks.open}>{t('failure.no-agent.action')}</a></Button>
              ) : null}
              <Button
                type="button" variant="outline" size="sm" data-testid="setup-preselect-use-new"
                onClick={() => { preselectSpent.current = true; startFocusAfter.current = true; setPreselectLetGo(true); }}
              >{t('preselect.useNew')}</Button>
            </div>
          </div>
        ) : short && agentRoom ? (
          // story 4717 AC1: the recipe needs more new agents than the plan has room for — said before the press, in the count line's place
          <RoomShort room={agentRoom} need={agents} canUseExisting={canUseExisting} />
        ) : (
          <p className="text-xs text-muted-foreground">
            {moveMode ? (needsProjectPick ? t('projectPick.reason') : !anyMovable ? t('move.noneMovable') : moveChosen.length === 0 ? t('move.noneChosen') : t('move.startNote', { m: moveChosen.length }))
              : noAgentRow ? t('noAgentRow')
              // story 4496 (Yuna 10:05Z ②): several projects and none picked — why «시작» is off, in the count line's place
              : needsProjectPick ? t('projectPick.reason')
              : startNote(t, agents, moved, humanList, humanRoles.length > 0)}
            {/* story 4717 AC1: the room, when a limit holds and this recipe makes new agents */}
            {!moveMode && !noAgentRow && !needsProjectPick && agentRoom && agents > 0
              ? <span data-testid="setup-agent-room"> · {t('room.left', { left: agentRoom.available })}</span> : null}
          </p>
        )}
        {/* directly below the line · stays after a press (aria-disabled while it reads — not `disabled`: keyboard focus stays on it, as 4678's
            [프로젝트 팀에 넣기]); the list arriving takes it away and focus goes to «시작» (effect above) */}
        {!moveMode && (attachableHold === 'failed' || (attachableHold === 'reading' && attachableRetried)) ? (
          <Button
            type="button" variant="outline" size="sm" className="self-start aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="setup-attachable-retry"
            aria-disabled={attachableHold === 'reading' || undefined}
            onClick={() => { if (attachableHold !== 'failed') return; setAttachableRetried(true); setAttachableTick((n) => n + 1); }}
          >{t('move.failureChangedAction')}</Button>
        ) : null}
        {rateLine ? <p className="text-xs text-muted-foreground" data-testid="setup-rate-limited">{rateLine}</p>
          : view.kind === 'error' ? <p className="text-xs text-muted-foreground">{view.message ?? t('genericError')}</p> : null}
      </footer>
    </Card>
  );
}

/** story #4565 (Yuna 02:32Z ② · 02:39Z): under a row moved from elsewhere — only when it has a live key: what the move does
 * (in the body's colour: it is a result to read), then when one of its keys was last used (muted · none known → no line).
 * story 4680 (Yuna G-4 · PO Q-b): a key that was never used (the agent the recruiter just made) has no live connection to cut —
 * no line: the screen does not name a cost that is not there. */
/**
 * story 4678 (P1′-a · Yuna §J ②③⑤): [프로젝트 팀에 넣기] on a line for an agent that is not on this project's team. Pressing it grants
 * in place (the page's putOnTeam); while it works the button reads «넣는 중…» and ignores presses — `aria-disabled`, not `disabled`, so
 * keyboard focus stays on it (a disabled button drops focus to the page). A failure says so under the button; the line stays.
 */
function PutOnTeamButton({ agent, state, onPress, fromHold = false }: { agent: AttachableAgent; state?: 'busy' | 'failed'; onPress: () => void; /** story 4703: the one under the reason line (its failure focus finds it, not the row's) */ fromHold?: boolean }) {
  const t = useTranslations('desktop.setup');
  const busy = state === 'busy';
  return (
    <span className="flex flex-col items-start gap-1">
      <Button
        type="button" variant="outline" size="sm"
        aria-disabled={busy || undefined}
        aria-label={busy ? undefined : t('putOnTeamAria', { name: agent.name })}
        className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
        onClick={() => { if (!busy) onPress(); }}
        data-put-on-team={fromHold ? undefined : agent.id} data-preselect-put={fromHold ? '' : undefined} data-testid={fromHold ? 'setup-preselect-put' : 'setup-put-on-team'}
      >
        {busy ? t('putOnTeamBusy') : t('putOnTeam')}
      </Button>
      {state === 'failed' ? <span role="alert" className="break-keep text-xs text-destructive" data-testid="setup-put-on-team-failed">{t('putOnTeamFailed')}</span> : null}
    </span>
  );
}

export function MovedAgentNote({ agent }: { agent: AttachableAgent | undefined }) {
  const t = useTranslations('desktop.setup');
  const locale = useLocale();
  const viewerTz = useViewerTimeZone();
  if (!agent || agent.live_keys < 1 || !agent.last_used_at) return null;
  const when = agent.last_used_at ? formatViewerRelativeTime(agent.last_used_at, locale, viewerTz) : '';
  return (
    <div className="mt-1 flex flex-col gap-0.5" data-testid="setup-moved-note">
      <p className="text-xs text-foreground">{t('movedWarning')}</p>
      {when ? <p className="text-xs text-muted-foreground">{t('lastConnected', { time: when })}</p> : null}
    </div>
  );
}

/** «시작» 아래 줄(4565 · Yuna 02:32Z ①): «만들고»는 새로 만드는 것만 세고, 옮겨 오는 것은 «옮겨»로 · 사람 역할이 있으면 꼬리. */
/** story 4717 AC2: «N개 필요 · M개 더» — M = 0 is its own sentence («0개만 더» read as nonsense). */
function roomCountsLine(t: ReturnType<typeof useTranslations<'desktop.setup'>>, need: number, left: number): string {
  return left === 0 ? t('room.shortNone', { need }) : t('room.short', { need, left });
}

/**
 * story 4717 AC1: before [시작], when the recipe as chosen makes more new agents than the plan has room for. «시작» is off (canStart);
 * this says how many, in the plan's words (the recruiter's rule — lib/plan-limit-copy), and the ways: an agent the organization
 * already has can take a row (no new agent · the rows' «이미 있는 에이전트» group, story #4565) · tidy up · upgrade where billing is open.
 */
function RoomShort({ room, need, canUseExisting }: { room: AgentRoom; need: number; canUseExisting: boolean }) {
  const t = useTranslations('desktop.setup');
  return (
    <RoomShortBox room={room} line={roomCountsLine(t, need, room.available)}
      hint={canUseExisting ? <p className="text-xs text-muted-foreground" data-testid="setup-room-use-existing">{t('room.useExisting')}</p> : null} />
  );
}

/**
 * story 4717 (follow-up · PO 05:04Z): the plan's agent room said before «시작» — one box for the recipe setup and the solo card
 * (desktop-setup-quick): the line it is given (how many · in that screen's words), the plan's limit in the recruiter's words
 * (lib/plan-limit-copy), an optional hint (the way that keeps the person's agents), then [에이전트 정리하기] · upgrade where billing is open.
 */
export function RoomShortBox({ room, line, hint = null }: { room: AgentRoom; line: string; hint?: ReactNode }) {
  const t = useTranslations('desktop.setup');
  const tNav = useTranslations('nav');
  const tRecruiter = useTranslations('recruiter');
  const flatHref = useFlatHref();
  const copy = limitCopy({ resource: 'agent', limit: room.limit, free: room.free, billingOpen: isEEEnabled() });
  return (
    <div className="flex flex-col gap-2" data-testid="setup-room-short">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]" role="status">
        {line}
        {copy.reason ? <> {tRecruiter(copy.reason.key, copy.reason.withLimit ? { limit: room.limit } : undefined)}</> : null}
      </p>
      {hint}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm"><a href={flatHref('/organization/workforce')}>{t('failure.agent-limit.manage')}</a></Button>
        {copy.link ? <Button asChild variant="outline" size="sm"><a href={flatHref('/settings?tab=billing')}>{tNav('orgLimitUpgradeLink')}</a></Button> : null}
      </div>
    </div>
  );
}

function startNote(t: ReturnType<typeof useTranslations<'desktop.setup'>>, made: number, moved: number, humanList: string, withMe: boolean): string {
  const me = withMe ? { roles: humanList, josa: pickEunNeunJosa(humanList) } : null;
  if (moved === 0) return me ? t('startNoteWithMe', { n: made, ...me }) : t('startNote', { n: made });
  if (made === 0) return me ? t('startNoteMovedWithMe', { m: moved, ...me }) : t('startNoteMoved', { m: moved });
  return me ? t('startNoteMadeMovedWithMe', { n: made, m: moved, ...me }) : t('startNoteMadeMoved', { n: made, m: moved });
}

/** story 4494 (Yuna 10:11Z ⓐ): the no-agent card's place and shape — one title and body per runtime that is only below its floor ·
 * no install command to copy (it is installed) · «다시 찾기» as on the no-agent card. */
export function TooOldCard({ old }: { old: OldRuntime[] }) {
  const t = useTranslations('desktop.setup');
  const links = useAppSetupLinks();
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="setup-too-old">
      {old.map((o) => (
        <div key={o.runtime} className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t('tooOld.title', { runtime: RUNTIME_LABEL[o.runtime], version: o.version })}</h1>
          <p className="text-sm text-muted-foreground">{t('tooOld.body', { min: o.min })}</p>
        </div>
      ))}
      <div className="flex gap-2"><Button asChild><a href={links.open}>{t('failure.no-agent.action')}</a></Button></div>
    </Card>
  );
}

export function Failure({ failure, onRetry, counts = null, plan = null, solo = false, onChooseRecipe, onReloadPage, todayHref }: { failure: SetupFailure; onRetry?: () => void; counts?: LimitCounts | null; plan?: AgentLimit | null; /** story 4717: the solo card (one agent, no recipe) — its own words, no «레시피» */ solo?: boolean; onChooseRecipe?: () => void; onReloadPage?: () => void; todayHref?: string }) {
  const t = useTranslations('desktop.setup');
  const tNav = useTranslations('nav');
  const tRecruiter = useTranslations('recruiter');
  // story 4717 AC2: the agent limit is worded by the one rule the recruiter's banner uses (lib/plan-limit-copy) — title, plan line, upgrade way
  const limit = failure === 'agent-limit' ? limitCopy({ resource: 'agent', limit: plan?.limit ?? null, free: plan?.free ?? true, billingOpen: isEEEnabled() }) : null;
  const flatHref = useFlatHref();
  const key = (part: 'title' | 'body' | 'action') => FAILURE_KEY[`${failure}.${part}`]!;
  const links = useAppSetupLinks();
  const appButton = (label: string) => <Button asChild><a href={links.open}>{label}</a></Button>;
  // story 4721 (Yuna invited-member-card-1017 §3): a MEMBER on the not-admin card has two ways out beside «다시 확인» — ask an admin (the
  // body says it) and start in an organization of their own (the primary, only while the plan lets them make one)
  const { orgId, orgMemberships, userName } = useDashboardContext();
  const tNewOrg = useTranslations('desktopOnboarding');
  const [createOpen, setCreateOpen] = useState(false);
  const [madeOrgId, setMadeOrgId] = useState<string | null>(null); // made, but the switch to it did not go through: the primary tries the switch again
  const [enterFailed, setEnterFailed] = useState(false);
  const [entering, setEntering] = useState(false); // the switch is on its way: a second press waits for it
  // the server wants the e-mail verified before an organization is made (an invited person's account has its own «verified» mark): the gate that
  // new-org mode already uses stands in the card's place until the mailbox is proved, then the card is back and the primary can be pressed again
  const [verifyWanted, setVerifyWanted] = useState(false);
  const verifyGate = useEmailVerifyGate(verifyWanted, () => setVerifyWanted(false));
  // asked for the gate but the server's own answer says the mailbox is proved (or cannot be read): no gate to show — the generic line
  const createRefused = verifyWanted && verifyGate.kind === 'open';
  const member = failure === 'not-admin' ? memberCardFacts(orgId, orgMemberships, isEEEnabled()) : null;
  const canCreate = !!member && (member.canCreateOwn || madeOrgId !== null);
  const org = member?.orgName ?? '';
  const memberBody = !member ? null
    : member.orgName ? (member.canCreateOwn ? t('failure.not-admin.body', { org }) : t('failure.not-admin.bodyAsk', { org }))
    : (member.canCreateOwn ? t('failure.not-admin.bodyNoName') : t('failure.not-admin.bodyNoNameAsk'));
  const reloadPage = onReloadPage ?? (() => window.location.reload());
  async function enterOwnOrg(newOrgId: string) {
    setEntering(true);
    setEnterFailed(false);
    try {
      const res = await fetchWithAuth('/api/switch-org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_id: newOrgId }) });
      const json = await res.json().catch(() => null) as { data?: { ok?: boolean } } | null;
      if (!(res.ok && json?.data?.ok)) { setEnterFailed(true); setEntering(false); return; }
      // the switcher's own order: the tab's project belongs to the organization left, so it goes before the page is read again
      window.sessionStorage.removeItem(TAB_PROJECT_STORAGE_KEY);
      reloadPage();
    } catch {
      setEnterFailed(true);
      setEntering(false);
    }
  }
  if (verifyWanted && verifyGate.kind === 'closed') return <EmailVerifyGateCard gate={verifyGate} />;
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">{limit ? tNav(limit.title) : t(key('title'))}</h1>
      {limit ? (
        <p className="text-sm text-muted-foreground" data-testid="setup-agent-limit-body">
          {solo ? <>{t('room.soloNone')} </> : counts ? <>{roomCountsLine(t, counts.need, counts.left)} </> : null}
          {/* the plan line needs the server's limit when numbers are shown — the number-less «모두 만들었어요» would contradict «1개만 더» */}
          {limit.reason && (plan?.limit != null || !counts) ? <>{tRecruiter(limit.reason.key, limit.reason.withLimit && plan?.limit != null ? { limit: plan.limit } : undefined)} </> : null}
          {solo ? t('room.soloTidy') : t(key('body'))}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{memberBody ?? t(key('body'))}</p>
      )}
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
          // story 4498 (Yuna 10:51Z): the way out sits beside it as on the progress page — outline «오늘로 가기»
          : failure === 'disconnected' ? <>
            {appButton(t(key('action')))}
            {todayHref ? <Button asChild variant="outline"><a href={todayHref}>{t('goToday')}</a></Button> : null}
          </>
          : (failure === 'offline' || failure === 'no-recipe' || failure === 'recipes-offline' || failure === 'recipes-changed' || failure === 'move-changed' || failure === 'move-offline') && onRetry ? <Button onClick={onRetry}>{t(key('action'))}</Button>
          : failure === 'not-admin' && canCreate ? <>
            <Button disabled={entering} onClick={() => { if (madeOrgId) void enterOwnOrg(madeOrgId); else setCreateOpen(true); }}>{t('failure.not-admin.create')}</Button>
            {/* once the organization is made, «다시 확인» is the same way back as the primary: a plain reload would drop the made organization and
                its switch (the new owner row would then close the primary) */}
            <Button variant="outline" disabled={entering} onClick={() => { if (madeOrgId) void enterOwnOrg(madeOrgId); else reloadPage(); }}>{t(key('action'))}</Button>
          </>
          : failure === 'not-admin' || failure === 'move-not-admin' || failure === 'managed' || failure === 'has-org' ? <Button onClick={reloadPage}>{t(key('action'))}</Button>
          : failure === 'recipe-too-big' && onChooseRecipe ? <Button onClick={onChooseRecipe}>{t(key('action'))}</Button>
          : failure === 'agent-limit' ? <>
            {onChooseRecipe ? <Button onClick={onChooseRecipe}>{t(key('action'))}</Button> : null}
            <Button variant="outline" asChild><a href={flatHref('/organization/workforce')}>{t('failure.agent-limit.manage')}</a></Button>
            {limit?.link ? <Button variant="outline" asChild><a href={flatHref('/settings?tab=billing')}>{tNav('orgLimitUpgradeLink')}</a></Button> : null}
          </>
          : null}
      </div>
      {enterFailed ? <p role="alert" className="text-sm text-destructive">{tNav('switcherSwitchOrgError')}</p> : null}
      {createRefused ? <p role="alert" className="text-sm text-destructive">{tNav('createOrgGenericError')}</p> : null}
      {member?.canCreateOwn ? (
        <CreateOrganizationDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialName={defaultOrgName(userName, (n) => tNewOrg('defaultOrgNameWithName', { name: n }), tNewOrg('defaultOrgName'))}
          slugOptional
          onEmailVerificationRequired={() => setVerifyWanted(true)}
          onCreated={(id) => { setMadeOrgId(id); void enterOwnOrg(id); }}
        />
      ) : null}
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

type JoinFail = 'already' | 'expired' | 'notMine' | 'unknown';
const JOIN_FAIL_KEY: Record<string, string> = { already: 'invited.fail.already', expired: 'invited.fail.expired', notMine: 'invited.fail.notMine', unknown: 'invited.fail.unknown' };

/**
 * (나) invited somewhere (Yuna f6cfda19 v2 · 4711 AC4 덧 sheet 2026-10-17): one line per invite — who invited · as what · until when — each with its own [들어가기]
 * that takes THAT invite from inside the app (`POST /api/invites/mine/{invite_id}/accept`: the list carries no token; the server decides and answers), then the
 * person is in that organization (`/api/switch-org`) and the page is read again; and one small link at the bottom, «내 조직을 새로 만들기».
 * One invite → a filled button; more → an outline button per line (one screen never has several filled ones). While a press is in flight every line's button is
 * off (no second accept). A failure is its own line under that row: already accepted · expired (that row's button goes) · not this account's · unknown.
 */
export function InvitedCard({ invites, onReload, onCreateOwn, ownBusy = false }: { invites: MyInvite[]; onReload: () => void; onCreateOwn: () => void; /** the caller's own-organization flow is on its way: the link waits */ ownBusy?: boolean }) {
  const t = useTranslations('desktop.setup');
  const locale = useLocale();
  const viewerTz = useViewerTimeZone(); // story #4443 PR2 — unknown yet: the row's place is held, no UTC day shown
  const [busy, setBusy] = useState<string | null>(null);
  const acceptedOrg = useRef<Record<string, string>>({}); // an invite that was taken but whose switch did not go through: the retry only switches (the invite is not pending any more)
  const inFlight = useRef(false); // two presses in the same tick both see the old `busy`: the ref is what keeps the second one out
  const [fails, setFails] = useState<Record<string, JoinFail>>({});
  const inviteRow = (i: MyInvite) => {
    const role = i.role === 'admin' ? t('invited.roleAdmin') : t('invited.roleMember');
    const row = t('invited.row', { org: i.org_name, role, josa: pickEuroJosa(role), date: inviteUntilDate(i.expires_at, locale, viewerTz ?? 'UTC') });
    return viewerTz ? row : <InvisibleSample>{row}</InvisibleSample>;
  };
  async function join(invite: MyInvite) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(invite.invite_id);
    setFails((f) => { const { [invite.invite_id]: _gone, ...rest } = f; return rest; });
    const fail = (why: JoinFail) => { setFails((f) => ({ ...f, [invite.invite_id]: why })); inFlight.current = false; setBusy(null); };
    try {
      let orgId: unknown = acceptedOrg.current[invite.invite_id];
      if (!orgId) {
        const res = await fetchWithAuth(`/api/invites/mine/${encodeURIComponent(invite.invite_id)}/accept`, { method: 'POST' });
        if (!res.ok) { fail(res.status === 409 ? 'already' : res.status === 410 ? 'expired' : res.status === 403 || res.status === 404 ? 'notMine' : 'unknown'); return; }
        // the backend's one shape (schemas/invite_accept.py AcceptInviteResponse: `{ ok, org_id, role }`, no envelope — the BFF route passes it through as it is)
        const body = (await res.json().catch(() => null)) as { org_id?: unknown } | null;
        orgId = body?.org_id;
        if (typeof orgId !== 'string' || !orgId) { fail('unknown'); return; }
        acceptedOrg.current[invite.invite_id] = orgId;
      }
      // the member now: the session was made before the membership, so the switch (which gives the session that organization) comes before the page is read again
      const sw = await fetchWithAuth('/api/switch-org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_id: orgId as string }) });
      const swJson = (await sw.json().catch(() => null)) as { data?: { ok?: boolean } } | null;
      if (!(sw.ok && swJson?.data?.ok)) { fail('unknown'); return; }
      window.sessionStorage.removeItem(TAB_PROJECT_STORAGE_KEY);
      onReload();
    } catch {
      fail('unknown');
    }
  }
  const filled = invites.length === 1;
  const failLine = (id: string) => {
    const why = fails[id];
    if (!why) return null;
    const alert = why === 'notMine' || why === 'unknown';
    return (
      <div className="mt-1 flex flex-col gap-1 text-xs" role={alert ? 'alert' : 'status'} data-testid={`setup-invited-fail-${why}`}>
        <p className={alert ? 'text-destructive' : 'text-muted-foreground'}>{t(JOIN_FAIL_KEY[why]!)}</p>
        {why === 'already' || why === 'notMine' ? <div><Button variant="outline" size="sm" onClick={onReload}>{t('failure.has-org.action')}</Button></div> : null}
      </div>
    );
  };
  return (
    <Card className="break-keep flex flex-col gap-3 p-6" data-testid="setup-invited">
      <h1 className="text-lg font-semibold">{t('invited.title')}</h1>
      <ul className="flex flex-col gap-3">
        {invites.map((i) => (
          <li key={i.invite_id} className="flex flex-col text-sm" data-testid="setup-invited-row">
            <span>{inviteRow(i)}</span>
            {fails[i.invite_id] !== 'expired' ? (
              <div className="mt-2">
                <Button
                  variant={filled ? 'default' : 'outline'} size="sm" className="whitespace-nowrap" disabled={busy !== null}
                  aria-label={t('invited.joinAria', { org: i.org_name })} aria-busy={busy === i.invite_id} onClick={() => void join(i)} data-testid="setup-invited-join"
                >
                  {busy === i.invite_id ? t('invited.joining') : t('invited.join')}
                </Button>
              </div>
            ) : null}
            {failLine(i.invite_id)}
          </li>
        ))}
      </ul>
      <div>
        <Button variant="link" size="sm" className="h-auto whitespace-normal px-0 py-0 text-xs underline" disabled={busy !== null || ownBusy} onClick={onCreateOwn} data-testid="setup-invited-own-org">
          {t('invited.createOwn')}
        </Button>
      </div>
    </Card>
  );
}

/**
 * The invited card as the app's setup page shows it: «내 조직을 새로 만들기» opens the same «새 조직 만들기» window the member card uses (the generic
 * organization route — it has no pending-invite check; the confirm-new-org of the setup start has, and would send the person back here), then the person is in
 * their new organization and the page is read again.
 */
export function InvitedInApp({ invites, onReload }: { invites: MyInvite[]; onReload: () => void }) {
  const { userName } = useDashboardContext();
  const tNewOrg = useTranslations('desktopOnboarding');
  const t = useTranslations('desktop.setup');
  const [open, setOpen] = useState(false);
  const [madeOrgId, setMadeOrgId] = useState<string | null>(null); // made, but the switch into it did not go through: the link tries the switch again, it does not make another
  const [entering, setEntering] = useState(false);
  const [enterFailed, setEnterFailed] = useState(false);
  async function enterOwnOrg(orgId: string) {
    setEntering(true);
    setEnterFailed(false);
    try {
      const res = await fetchWithAuth('/api/switch-org', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ org_id: orgId }) });
      const json = (await res.json().catch(() => null)) as { data?: { ok?: boolean } } | null;
      if (!(res.ok && json?.data?.ok)) { setEnterFailed(true); setEntering(false); return; }
      window.sessionStorage.removeItem(TAB_PROJECT_STORAGE_KEY);
      onReload();
    } catch {
      setEnterFailed(true);
      setEntering(false);
    }
  }
  return (
    <>
      <InvitedCard
        invites={invites} onReload={onReload} ownBusy={entering}
        onCreateOwn={() => { if (madeOrgId) void enterOwnOrg(madeOrgId); else setOpen(true); }}
      />
      {enterFailed ? <p className="mt-2 break-keep text-xs text-destructive" role="alert" data-testid="setup-invited-own-org-failed">{t('invited.fail.unknown')}</p> : null}
      <CreateOrganizationDialog
        open={open}
        onOpenChange={setOpen}
        initialName={defaultOrgName(userName, (n) => tNewOrg('defaultOrgNameWithName', { name: n }), tNewOrg('defaultOrgName'))}
        slugOptional
        onCreated={(id) => { setMadeOrgId(id); void enterOwnOrg(id); }}
      />
    </>
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
/** The `#…` of an address (`#` included), or null when the address cannot be read. */
function hashOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hash; } catch { return null; }
}

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
    // story 4504: the `#` this change brought, from the event — by the time the handler runs, another replace of the address (the
    // shell's `?p=` normalization) may already have taken it off `location`.
    const onHash = (e: HashChangeEvent) => {
      const hash = hashOf(e.newURL) ?? window.location.hash;
      const q = parseSetupFragment(hash);
      const progress = q ? null : progressFromFragment(hash);
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

/** story 4701: how long «시작» waits for the existing-agents list before the page says it failed (Yuna 4701-copy-1015 §3: the limit is the implementer's call) */
export const ATTACHABLE_READ_LIMIT_MS = 10_000;

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
  const [teamPath, setTeamPath] = useState(false);
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
  // story 4711: an app that can take the first setup in three steps gets that card; the recipe setup is one link away («팀 꾸리기»).
  // A recruiter's agent (`agent=`) keeps the recipe page for now — its own branch of the card comes with the recruiter's PR.
  // story 4711 (`agent=` branch): a recruiter's agent, an app that can move → the card with ① fixed to that agent (a move, never a new agent)
  if (query.agent && query.canMove === true && !teamPath) return <DesktopSetupAgent query={query} onTeam={() => setTeamPath(true)} />;
  if (showsQuickCard(query, teamPath) && !query.agent) return <DesktopSetupQuick query={query} onTeam={() => setTeamPath(true)} />;
  return <DesktopSetup code={query.code} runtimes={query.runtimes} blocked={query.blocked} setupId={query.setupId} old={query.old ?? []} canMove={query.canMove === true} preselect={query.agent ?? null} />;
}

/** 코드 없이 브라우저로 직접 온 경우(AC5). */
export function OpenInDesktopApp() {
  const t = useTranslations('desktop.setup');
  const links = useAppSetupLinks();
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">{t('direct.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('direct.body')}</p>
      <div><Button asChild><a href={links.reopen}>{t('direct.action')}</a></Button></div>
    </Card>
  );
}

/** 레시피 카드 아래 줄 «역할 {n} · {역할 목록}»(유나 표). */
/** story 4653 (Yuna ⑤): the runtime chip (fixed) · the names added (removable) · one add input. A name outside the judged list shows
 *  «no sign-in line». Nothing added: the hint says only Claude Code and Codex are checked. */
function AgentToolsLine({ runtime, tools, onChange }: { runtime: DesktopRuntime; tools: string[]; onChange: (next: string[]) => void }) {
  const t = useTranslations('desktop.setup');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<'invalid' | 'duplicate' | 'max' | null>(null);
  const add = () => {
    const res = addAgentTool(tools, runtime, draft);
    if (!res.ok) { setError(res.reason); return; }
    onChange(res.tools);
    setDraft('');
    setError(null);
  };
  const extraWithoutCheck = tools.filter((x) => !hasSignInCheck(x, runtime));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="agent-tools">
      <span className="text-xs text-muted-foreground">{t('tools.label')}</span>
      <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{runtime}</span>
      {tools.map((name) => (
        <span key={name} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-foreground">
          {name}
          <Button type="button" variant="ghost" size="sm" className="h-auto p-0 text-muted-foreground" aria-label={t('tools.remove', { tool: name })} onClick={() => onChange(tools.filter((x) => x !== name))}>×</Button>
        </span>
      ))}
      <input
        aria-label={t('tools.label')}
        list="agent-tool-suggestions"
        className="h-7 w-40 rounded-md border bg-background px-2 text-base lg:text-sm"
        placeholder={t('tools.placeholder')}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
      />
      <datalist id="agent-tool-suggestions">{JUDGED_AGENT_TOOLS.map((x) => <option key={x} value={x} />)}</datalist>
      <Button type="button" variant="outline" size="sm" className="h-6 rounded-full px-2 text-xs" onClick={add}>{t('tools.add')}</Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error === 'invalid' ? t('tools.error.invalid') : error === 'duplicate' ? t('tools.error.duplicate') : t('tools.error.max')}</span> : null}
      {tools.length === 0 ? <span className="basis-full text-xs text-muted-foreground">{t('tools.hint')}</span> : null}
      {extraWithoutCheck.length > 0 ? <span className="basis-full text-xs text-muted-foreground">{t('tools.noSignInLine')}</span> : null}
    </div>
  );
}

function RecipeRolesLine({ recipe, runtimes }: { recipe: SetupRecipe; runtimes: DesktopRuntime[] }) {
  const t = useTranslations('desktop.setup');
  const tOrg = useTranslations('organization');
  // the same order as the rows below and the recipe gallery (orderedRecipeRoles — one order per recipe · Yuna 12:49Z)
  const roles = setupRoleRows(recipe, runtimes).map((r) => stageRoleLabel(r.role, tOrg));
  if (roles.length === 0) return null;
  return <span className="block text-xs text-muted-foreground">{t('recipeRoles', { n: roles.length, roles: roles.join(' · ') })}</span>;
}
