'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fetchWithAuth } from '@/lib/db/client';
import { presetDescription, presetName } from '@/lib/platform-preset-copy';
import { pickEunNeunJosa } from '@/lib/korean-particle';
import { useFlatHref } from '@/hooks/use-flat-href';
import { stageRoleLabel } from '@/lib/stage-role';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { SetupProgressView } from './desktop-setup-progress';
import {
  agentRowCount, confirmBody, hasSetupFragment, listableRecipe, parseSetupFragment, rememberActiveSetup, type SetupQuery, defaultWorkdirHint, needsAnAgent, setupRoleRows, workdirInputOk,
  type DesktopRuntime, type RowOwner, type SetupRecipe, type SetupRoleRow,
} from '@/lib/desktop-setup';

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

export type SetupFailure = 'no-agent' | 'not-admin' | 'agent-limit' | 'expired' | 'offline' | 'managed' | 'no-recipe';

/** 실패 화면 문구 키 — `Record<string, string>` 리터럴 표(키 가드가 이 모양의 값을 «읽힘»으로 센다). */
const FAILURE_KEY: Record<string, string> = {
  'no-agent.title': 'failure.no-agent.title', 'no-agent.body': 'failure.no-agent.body', 'no-agent.action': 'failure.no-agent.action',
  'not-admin.title': 'failure.not-admin.title', 'not-admin.body': 'failure.not-admin.body', 'not-admin.action': 'failure.not-admin.action',
  'agent-limit.title': 'failure.agent-limit.title', 'agent-limit.body': 'failure.agent-limit.body', 'agent-limit.action': 'failure.agent-limit.action',
  'expired.title': 'failure.expired.title', 'expired.body': 'failure.expired.body', 'expired.action': 'failure.expired.action',
  'offline.title': 'failure.offline.title', 'offline.body': 'failure.offline.body', 'offline.action': 'failure.offline.action',
  'managed.title': 'failure.managed.title', 'managed.body': 'failure.managed.body', 'managed.action': 'failure.managed.action',
  'no-recipe.title': 'failure.no-recipe.title', 'no-recipe.body': 'failure.no-recipe.body', 'no-recipe.action': 'failure.no-recipe.action',
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

type View =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'starting' }
  | { kind: 'started' }
  /** `retry`: what «다시 시도 / 다시 확인» does — read the list again, or send the confirm again. */
  | { kind: 'failed'; failure: SetupFailure; counts?: LimitCounts | null; retry?: 'load' | 'confirm' }
  | { kind: 'error' };

function ownerKey(o: RowOwner): string { return o.kind === 'me' ? 'me' : o.runtime; }

export function DesktopSetup({ code, runtimes: found, blocked = [], setupId = null }: { code: string; runtimes: DesktopRuntime[]; blocked?: DesktopRuntime[]; setupId?: string | null }) {
  // ⑥ 갈래 가: 찾았지만 회사 설정으로 도구를 못 붙이는 런타임은 고를 수 없고, 꺼진 선택지로만 보인다. PO 08:37Z · 유나 08:38Z.
  const runtimes = useMemo(() => found.filter((r) => !blocked.includes(r)), [found, blocked]);
  const claudeBlocked = blocked.includes('claude');
  const t = useTranslations('desktop.setup');
  const tPreset = useTranslations('recipePreset');
  const tOrg = useTranslations('organization');
  const { projectId, userName, orgId, orgMemberships } = useDashboardContext();
  // 에이전트를 만드는 건 조직 owner/admin(4424 not_org_admin) — 조직 역할은 orgMemberships(content-rules와 같은 판정)
  const orgRole = orgMemberships?.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isAdmin = orgRole === 'owner' || orgRole === 'admin';
  const [recipes, setRecipes] = useState<SetupRecipe[]>([]);
  const [recipeId, setRecipeId] = useState<string>('');
  const [rows, setRows] = useState<SetupRoleRow[]>([]);
  const [workdir, setWorkdir] = useState('');
  const [editingDir, setEditingDir] = useState(false);
  const [view, setView] = useState<View>({ kind: 'loading' });

  // 로그인이 필요했던 설정이면 한 번(4426 · 사람 손 셈) — 설정 id가 없으면 이 흐름에 묶을 수 없어 보내지 않는다
  useEffect(() => {
    if (!setupId) return;
    rememberActiveSetup(setupId); // 이 탭에서 문서를 열면 desktop_doc_opened로 셈(DesktopSetupDocWatch)
  }, [setupId]);

  // bumped by «다시 확인 / 다시 시도» after the list could not be read or came back empty — reads the list again
  const [loadTick, setLoadTick] = useState(0);
  const reload = () => { setView({ kind: 'loading' }); setLoadTick((n) => n + 1); };

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        // the recipes this setup can start, each with its rows — worked out by the server with the function confirm checks
        // with (4831): the page draws them as they come (list order = the default is the first — no «recommended» tag)
        const res = await fetchWithAuth('/api/desktop/recipes');
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        const list: SetupRecipe[] = body?.recipes ?? body?.data?.recipes ?? [];
        const usable = list.filter((d) => listableRecipe(d, presetName(d, tPreset)));
        if (off) return;
        setRecipes(usable);
        if (usable[0]) pick(usable[0]);
        setView(usable.length ? { kind: 'choose' } : { kind: 'failed', failure: 'no-recipe', retry: 'load' });
      } catch {
        if (!off) setView({ kind: 'failed', failure: 'offline', retry: 'load' });
      }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTick]);

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
    if (!recipe || !projectId) return;
    setView({ kind: 'starting' });
    try {
      const res = await fetchWithAuth('/api/desktop/setup-codes/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmBody(code, rows, projectId, recipe.id, workdir)),
      });
      if (res.ok) { setView({ kind: 'started' }); return; }
      const body = await res.json().catch(() => null);
      const failure = failureForCode(body?.error?.code, body?.error?.resource);
      setView(failure ? { kind: 'failed', failure, counts: failure === 'agent-limit' ? limitCounts(body?.error) : null } : { kind: 'error' });
    } catch {
      setView({ kind: 'failed', failure: 'offline', retry: 'confirm' });
    }
  }

  if (!isAdmin && view.kind !== 'loading') return <Failure failure="not-admin" />;
  if (view.kind === 'loading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (view.kind === 'failed') {
    const onRetry = view.retry === 'load' ? reload : view.failure === 'offline' ? () => void start() : undefined;
    return <Failure failure={view.failure} counts={view.counts ?? null} onRetry={onRetry}
      onChooseRecipe={view.failure === 'agent-limit' ? () => setView({ kind: 'choose' }) : undefined} />;
  }
  // 쓸 수 있는 런타임이 하나도 없을 때: 막힌 것만 있으면 ⑥ 전체 화면, 아무것도 못 찾았으면 ①
  if (runtimes.length === 0 && needsAnAgent(rows, runtimes)) return <Failure failure={blocked.length > 0 ? 'managed' : 'no-agent'} />;
  if (view.kind === 'started') return <SetupProgressView setupId={setupId} recipeName={recipe ? presetName(recipe, tPreset) : ''} />;

  const setOwner = (role: string, key: string) => setRows((rs) => rs.map((r) => (r.role === role ? { ...r, owner: r.choices.find((c) => ownerKey(c) === key) ?? r.owner } : r)));
  const canStart = !!recipe && !!projectId && workdirInputOk(workdir) && view.kind === 'choose';

  return (
    <Card className="flex flex-col gap-6 p-6">
      <header>
        <p className="text-xs text-muted-foreground">{t('eyebrow')}</p>
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('lead')}</p>
      </header>

      <section aria-labelledby="setup-recipe">
        <h2 id="setup-recipe" className="text-sm font-medium">{t('recipe')}</h2>
        <div role="radiogroup" aria-labelledby="setup-recipe" className="mt-2 flex flex-col gap-2">
          {recipes.map((r) => (
            <label key={r.id} className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary">
              <input type="radio" name="recipe" value={r.id} checked={r.id === recipeId} onChange={() => pick(r)} className="mt-1" />
              <span><span className="block text-sm font-medium">{presetName(r, tPreset)}</span>
                {presetDescription(r, tPreset) ? <span className="block text-xs text-muted-foreground">{presetDescription(r, tPreset)}</span> : null}
                <RecipeRolesLine recipe={r} runtimes={runtimes} /></span>
            </label>
          ))}
        </div>
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
                ? <span className="text-sm">{r.owner.kind === 'me' ? t('me', { name: userName ?? '' }) : t('onThisComputer', { runtime: RUNTIME_LABEL[r.owner.runtime] })}</span>
                : (
                  <select aria-label={t('ownerFor', { role: roleName(r.role) })} className="max-w-[55%] shrink-0 rounded-md border bg-background px-2 py-1 text-base lg:text-sm"
                    value={ownerKey(r.owner)} onChange={(e) => setOwner(r.role, e.target.value)}>
                    {r.choices.map((c) => <option key={ownerKey(c)} value={ownerKey(c)}>{c.kind === 'me' ? t('me', { name: userName ?? '' }) : RUNTIME_LABEL[c.runtime]}</option>)}
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
              <Button variant="ghost" size="sm" onClick={() => setEditingDir(true)}>{t('change')}</Button>
            </div>
          )}
        {!workdirInputOk(workdir) ? <p className="mt-1 text-xs text-muted-foreground">{t('folderHint')}</p> : null}
      </section>

      <footer className="flex flex-col gap-2">
        <Button onClick={() => void start()} disabled={!canStart}>
          {view.kind === 'starting' ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}{t('start')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {humanRoles.length > 0 ? t('startNoteWithMe', { n: agents, roles: humanList, josa: pickEunNeunJosa(humanList) }) : t('startNote', { n: agents })}
        </p>
        {/* what the agents ask and what they do not (PO 00:41Z · Yuna v17): Sprintable's own tools are pre-allowed; files ·
            commands · other tools still ask each time */}
        <p className="text-xs text-muted-foreground">{t('toolNote')}</p>
        {view.kind === 'error' ? <p className="text-xs text-muted-foreground">{t('genericError')}</p> : null}
      </footer>
    </Card>
  );
}

export function Failure({ failure, onRetry, counts = null, onChooseRecipe }: { failure: SetupFailure; onRetry?: () => void; counts?: LimitCounts | null; onChooseRecipe?: () => void }) {
  const t = useTranslations('desktop.setup');
  const flatHref = useFlatHref();
  const key = (part: 'title' | 'body' | 'action') => FAILURE_KEY[`${failure}.${part}`]!;
  const appButton = (label: string) => <Button asChild><a href={SETUP_APP_LINK}>{label}</a></Button>;
  return (
    <Card className="flex flex-col gap-3 p-6">
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
          : (failure === 'offline' || failure === 'no-recipe') && onRetry ? <Button onClick={onRetry}>{t(key('action'))}</Button>
          : failure === 'not-admin' || failure === 'managed' ? <Button onClick={() => window.location.reload()}>{t(key('action'))}</Button>
          : failure === 'agent-limit' ? <>
            {onChooseRecipe ? <Button onClick={onChooseRecipe}>{t(key('action'))}</Button> : null}
            <Button variant="outline" asChild><a href={flatHref('/organization/workforce')}>{t('failure.agent-limit.manage')}</a></Button>
          </>
          : null}
      </div>
    </Card>
  );
}

/**
 * ⑦ 원인 모름 — 에이전트는 켜졌지만 우리 도구 연결이 «아직» 붙지 않음(단정 X · 유나 v13). 뜨는 때와 걷히는 때는
 * setupProgress(사람 입력 + 30초 · 받은 것을 본 때 + 180초 — PO 12:25Z). 연결이 뒤늦게 붙으면 단계로 돌아간다.
 */
export function ToolsNotConnected({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('desktop.setup');
  return (
    <Card className="flex flex-col gap-3 p-6">
      <h2 className="text-base font-semibold">{t('notConnected.title')}</h2>
      <p className="text-sm text-muted-foreground">{t('notConnected.body')}</p>
      <div><Button onClick={onRetry}>{t('notConnected.action')}</Button></div>
    </Card>
  );
}

/**
 * 주소의 `#` 뒤에서 설정 값을 읽고 곧바로 주소에서 지운다(코드는 어떤 URL에도 남기지 않는다 — PO 09:45Z). 값은 이 컴포넌트의
 * 메모리에만 있다. 로그인을 거쳐 `#` 없이 돌아오면 데스크톱 앱이 값을 붙여 다시 연다(PO 09:58Z) — 웹은 맡아 두지 않는다.
 */
export function DesktopSetupEntry() {
  const [entry, setEntry] = useState<{ query: SetupQuery | null } | null>(null);
  const searchParams = useSearchParams();
  const strip = () => window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  useEffect(() => {
    const hash = window.location.hash;
    const query = parseSetupFragment(hash);
    // off the address at once; the state change follows on the next microtask (no cascading render inside the effect)
    if (hash) strip();
    void Promise.resolve().then(() => setEntry({ query }));
    // The values can also arrive AFTER this page is up: after an email login the desktop app reopens the same page with its `#`,
    // and that is a same-document fragment change, not a new load (dev 실측 15:24Z — the page showed «데스크톱 앱에서 열어 주세요»).
    // A newer code replaces an older one (the app restarted the setup).
    const onHash = () => {
      const q = parseSetupFragment(window.location.hash);
      if (!q) return;
      strip();
      setEntry({ query: q });
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
  return entry.query
    ? <DesktopSetup key={entry.query.code} code={entry.query.code} runtimes={entry.query.runtimes} blocked={entry.query.blocked} setupId={entry.query.setupId} />
    : <OpenInDesktopApp />;
}

/** 코드 없이 브라우저로 직접 온 경우(AC5). */
export function OpenInDesktopApp() {
  const t = useTranslations('desktop.setup');
  return (
    <Card className="flex flex-col gap-3 p-6">
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
