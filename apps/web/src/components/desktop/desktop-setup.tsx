'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { fetchWithAuth } from '@/lib/db/client';
import { presetDescription, presetName } from '@/lib/platform-preset-copy';
import { pickEunNeunJosa } from '@/lib/korean-particle';
import { stageRoleLabel } from '@/lib/stage-role';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  agentRowCount, confirmBody, defaultWorkdirHint, needsAnAgent, setupRoleRows, workdirInputOk,
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
const INSTALL: Record<DesktopRuntime, string> = { claude: 'npm install -g @anthropic-ai/claude-code', codex: 'npm install -g @openai/codex' };

export type SetupFailure = 'no-agent' | 'not-admin' | 'agent-limit' | 'expired' | 'offline' | 'managed';

/** 실패 화면 문구 키 — `Record<string, string>` 리터럴 표(키 가드가 이 모양의 값을 «읽힘»으로 센다). */
const FAILURE_KEY: Record<string, string> = {
  'no-agent.title': 'failure.no-agent.title', 'no-agent.body': 'failure.no-agent.body', 'no-agent.action': 'failure.no-agent.action',
  'not-admin.title': 'failure.not-admin.title', 'not-admin.body': 'failure.not-admin.body', 'not-admin.action': 'failure.not-admin.action',
  'agent-limit.title': 'failure.agent-limit.title', 'agent-limit.body': 'failure.agent-limit.body', 'agent-limit.action': 'failure.agent-limit.action',
  'expired.title': 'failure.expired.title', 'expired.body': 'failure.expired.body', 'expired.action': 'failure.expired.action',
  'offline.title': 'failure.offline.title', 'offline.body': 'failure.offline.body', 'offline.action': 'failure.offline.action',
  'managed.title': 'failure.managed.title', 'managed.body': 'failure.managed.body', 'managed.action': 'failure.managed.action',
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

type View =
  | { kind: 'loading' }
  | { kind: 'choose' }
  | { kind: 'starting' }
  | { kind: 'started' }
  | { kind: 'failed'; failure: SetupFailure }
  | { kind: 'error' };

function ownerKey(o: RowOwner): string { return o.kind === 'me' ? 'me' : o.runtime; }

export function DesktopSetup({ code, runtimes: found, blocked = [] }: { code: string; runtimes: DesktopRuntime[]; blocked?: DesktopRuntime[] }) {
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

  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/api/events/definitions');
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        const list: (SetupRecipe & { enabled?: boolean; payload_schema?: SetupRecipe['payload_schema'] })[] = Array.isArray(body) ? body : body?.data ?? [];
        // 레시피 = 흐름(stage 목록)이 있고 켜져 있는 정의 · 목록 순서 그대로(첫째가 기본값 — 추천 딱지 없음)
        const usable = list.filter((d) => d.enabled !== false && (d.payload_schema?.properties?.stage?.enum?.length ?? 0) > 0);
        if (off) return;
        setRecipes(usable);
        if (usable[0]) pick(usable[0]);
        setView({ kind: 'choose' });
      } catch {
        if (!off) setView({ kind: 'failed', failure: 'offline' });
      }
    })();
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const res = await fetchWithAuth(`/api/desktop/setup-codes/${code}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmBody(rows, projectId, recipe.id, workdir)),
      });
      if (res.ok) { setView({ kind: 'started' }); return; }
      const body = await res.json().catch(() => null);
      const failure = failureForCode(body?.error?.code, body?.error?.resource);
      setView(failure ? { kind: 'failed', failure } : { kind: 'error' });
    } catch {
      setView({ kind: 'failed', failure: 'offline' });
    }
  }

  if (!isAdmin && view.kind !== 'loading') return <Failure failure="not-admin" />;
  if (view.kind === 'loading') return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  if (view.kind === 'failed') return <Failure failure={view.failure} onRetry={view.failure === 'offline' ? () => void start() : undefined} />;
  // 쓸 수 있는 런타임이 하나도 없을 때: 막힌 것만 있으면 ⑥ 전체 화면, 아무것도 못 찾았으면 ①
  if (runtimes.length === 0 && needsAnAgent(rows, runtimes)) return <Failure failure={blocked.length > 0 ? 'managed' : 'no-agent'} />;
  if (view.kind === 'started') return <Card className="p-6"><h1 className="text-lg font-semibold">{t('startedTitle')}</h1><p className="mt-1 text-sm text-muted-foreground">{t('startedBody')}</p></Card>;

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
                {presetDescription(r, tPreset) ? <span className="block text-xs text-muted-foreground">{presetDescription(r, tPreset)}</span> : null}</span>
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
              <span className="min-w-0">
                <span className="block text-sm font-medium">{roleName(r.role)}</span>
                <span className="block text-xs text-muted-foreground">{r.actor === 'human' ? t('whoHuman') : r.actor === 'either' ? t('whoEither') : t('whoAgent')}</span>
              </span>
              {r.choices.length === 1
                ? <span className="text-sm">{r.owner.kind === 'me' ? t('me', { name: userName ?? '' }) : t('onThisComputer', { runtime: RUNTIME_LABEL[r.owner.runtime] })}</span>
                : (
                  <select aria-label={t('ownerFor', { role: roleName(r.role) })} className="rounded-md border bg-background px-2 py-1 text-sm"
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
        {view.kind === 'error' ? <p className="text-xs text-muted-foreground">{t('genericError')}</p> : null}
      </footer>
    </Card>
  );
}

function Failure({ failure, onRetry }: { failure: SetupFailure; onRetry?: () => void }) {
  const t = useTranslations('desktop.setup');
  const key = (part: 'title' | 'body' | 'action') => FAILURE_KEY[`${failure}.${part}`]!;
  const appButton = (label: string) => <Button asChild><a href={SETUP_APP_LINK}>{label}</a></Button>;
  return (
    <Card className="flex flex-col gap-3 p-6">
      <h1 className="text-lg font-semibold">{t(key('title'))}</h1>
      <p className="text-sm text-muted-foreground">{t(key('body'))}</p>
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
          : failure === 'offline' && onRetry ? <Button onClick={onRetry}>{t(key('action'))}</Button>
          : failure === 'not-admin' || failure === 'managed' ? <Button onClick={() => window.location.reload()}>{t(key('action'))}</Button>
          : null}
      </div>
    </Card>
  );
}

/**
 * ⑥ 갈래 나 — 원인 모름. PO 08:37Z · 유나 08:38Z. 에이전트는 켜졌지만 우리 도구 연결이 붙지 않은 경우. 원인을 단정하지 않는다.
 * 띄우는 신호(설정 상태의 tools_connected)는 디디군 측정 뒤 — 화면과 문구만 먼저.
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
