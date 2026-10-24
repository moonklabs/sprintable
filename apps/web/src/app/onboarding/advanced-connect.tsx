'use client';

// story 4766 (AC1–AC4): the web way, folded under «고급» on the first screen — for a person who already runs Claude Code or Codex on this
// computer and does not want the app. One press makes the project, the agent and its key and copies the ONE line to paste in a terminal
// (it registers the hosted server and opens the agent with the first message — see lib/onboarding/connect-command.ts). The connection
// panel (4761) then turns «connected» by itself when the agent makes its first tool call. Four steps in all: open this fold · press ·
// paste · allow the tool in the agent.
//
// What the screen says about the key (Kadir's lens · PO): the line holds it, so shell history · clipboard · the agent's settings file keep
// it — said by name, with [키 폐기] in the same place. It is shown masked, once; the clipboard is the only place it is copied from.
// What the web does NOT do (4765's line · PO): it never runs anything on the computer and does not guess what is installed there — it names
// the two programs it needs, gives the install commands (the same constants the app's setup screen uses) and says the app checks them.

import { useCallback, useRef, useState } from 'react';
import { Check, Copy, KeyRound, Loader2, Terminal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { fetchWithAuth, refreshAuthTokens } from '@/lib/db/client';
import { copyPromisedText, copyTextSafely } from '@/lib/clipboard';
import { ViewerDate } from '@/components/viewer-time-zone';
import { VIEWER_TIME_OPTIONS } from '@/lib/viewer-time-zone';
import { withProjectParam } from '@/hooks/use-flat-href';
import { createFirstInstructionConversation } from '@/lib/onboarding/first-instruction';
import { buildConnectLine, CODEX_KEY_ENV, isPlainKey, maskKey, mcpUrlFromArtifact, type ConnectRuntime } from '@/lib/onboarding/connect-command';
import { INSTALL, RUNTIME_LABEL } from '@/components/desktop/desktop-setup';
import { emitOnboardingEvent } from './onboarding-telemetry';
import { VerifyRail, useVerificationRail } from './verify-rail';

type Phase = 'idle' | 'working' | 'ready' | 'failed';
type Failure = 'network' | 'project' | 'agent' | 'hosted' | 'key';

interface Made {
  projectId: string;
  agentId: string;
  /** the key as the server gave it — only in memory, only to build the line that is copied */
  key: string;
  mcpUrl: string;
}

interface AdvancedConnectProps {
  orgId: string | null;
  /** the landing the fold ends on (the person's own «오늘»/«대시보드» word is the caller's) */
  onFinish: () => void;
  todayV3Enabled?: boolean;
  /** true while the press is making things — the screen's other way out (오늘로 가기) waits, or an agent and key could be made with nothing left to revoke them */
  onWorking?: (working: boolean) => void;
}

/** what a press has made so far: a retry after a late failure resumes from here instead of making a second agent */
interface Draft { projectId?: string; agentId?: string; key?: string }

const NEW_KEY_DAYS = 90; // the same default the agent's key manager offers
/** where Claude Code keeps the key `claude mcp add` is given (measured: ~/.claude.json, mode 0600, plain text) — passed into the sentence, not written in it */
const CLAUDE_SETTINGS_FILE = '~/.claude.json';
/** the option Claude Code's first-run folder question is answered with — its own on-screen word, passed in rather than written into the sentence */
const CLAUDE_TRUST_YES = 'Yes';

export function AdvancedConnect({ orgId, onFinish, todayV3Enabled = false, onWorking }: AdvancedConnectProps) {
  const t = useTranslations('onboarding.advanced');
  const tOnb = useTranslations('onboarding');
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [made, setMade] = useState<Made | null>(null);
  const [runtime, setRuntime] = useState<ConnectRuntime>('claude');
  const [copied, setCopied] = useState(false);
  const [copyFailedLine, setCopyFailedLineState] = useState<string | null>(null);
  const [rawShownFor, setRawShownFor] = useState<string | null>(null); // the real line is shown only after a press, and only for the line pressed for
  // every change of the failed line (a new failure, a toggle, a re-copy) withdraws an earlier reveal: «hidden until pressed» holds each time, not once
  const setCopyFailedLine = (line: string | null) => { setCopyFailedLineState(line); setRawShownFor(null); };
  const [revoked, setRevoked] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeFailed, setRevokeFailed] = useState(false);
  const [startingInstruction, setStartingInstruction] = useState(false);
  const [installCopied, setInstallCopied] = useState<ConnectRuntime | null>(null);
  const draft = useRef<Draft>({});

  const sentence = tOnb('verifyExamplePrompt');

  const lineFor = useCallback((m: Made, rt: ConnectRuntime, masked: boolean) =>
    buildConnectLine({ runtime: rt, mcpUrl: m.mcpUrl, key: m.key, sentence, masked }), [sentence]);

  /** The clipboard gets the real line; a failure is said and the line is offered to select by hand (the same pattern as the config card) */
  const copyLine = useCallback(async (m: Made, rt: ConnectRuntime) => {
    const line = lineFor(m, rt, false);
    const result = await copyTextSafely(line);
    if (!result.ok) {
      setCopied(false);
      setCopyFailedLine(line);
      return;
    }
    setCopyFailedLine(null);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    emitOnboardingEvent('config_copied', { agent_id: m.agentId, flow: 'onboarding' });
  }, [lineFor]);

  const fail = (f: Failure) => { setFailure(f); setPhase('failed'); };

  /** the organization's first project: the one that is there (the oldest — the list is the signed-in organization's own), or one made with a
   *  made name (never asked for). A list that could not be read is a failure — never «there is none», or a project is made twice. */
  const ensureProject = async (): Promise<string | null> => {
    const listed = await fetchWithAuth('/api/projects');
    if (!listed.ok) return null;
    const body = (await listed.json().catch(() => null)) as { data?: { id: string; created_at?: string }[] } | null;
    if (!body || !Array.isArray(body.data)) return null;
    // by the instant (offsets differ), a missing or unreadable time last
    const at = (c?: string) => { const n = c ? Date.parse(c) : NaN; return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY; };
    const oldest = [...body.data].sort((a, b) => at(a.created_at) - at(b.created_at))[0];
    if (oldest?.id) return oldest.id;
    const res = await fetchWithAuth('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, name: t('defaultProject'), description: null }),
    });
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { data?: { id: string } } | null;
    return json?.data?.id ?? null;
  };

  /** a key for an agent that already exists (the press made the agent but did not get the key · or the first key was revoked) */
  const issueKey = async (agentId: string): Promise<string | null> => {
    const res = await fetchWithAuth(`/api/agents/${agentId}/api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: null, expires_at: new Date(Date.now() + NEW_KEY_DAYS * 24 * 60 * 60 * 1000).toISOString() }),
    });
    const json = (await res.json().catch(() => null)) as { data?: { api_key?: string } } | null;
    return res.ok && isPlainKey(json?.data?.api_key) ? json!.data!.api_key! : null;
  };

  const hostedAddress = async (agentId: string): Promise<string | null> => {
    const res = await fetchWithAuth(`/api/agents/${agentId}/connection-artifact?transport=http`);
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as { data?: { files?: { filename: string; content: string }[] }; files?: { filename: string; content: string }[] } | null;
    const files = json?.data?.files ?? json?.files ?? [];
    return mcpUrlFromArtifact(files.find((f) => f.filename === '.mcp.json')?.content);
  };

  const make = async () => {
    if (!orgId || phase === 'working') return;
    setPhase('working');
    setFailure(null);
    onWorking?.(true);
    // The clipboard write starts HERE, inside the press: the line does not exist yet (the answers below make it), and a browser that wants a
    // recent gesture for the clipboard would refuse a write made after them. The write is handed a promise; if anything fails the promise
    // rejects and the clipboard is left as it was.
    let resolveLine: (line: string) => void = () => undefined;
    let rejectLine: (e: unknown) => void = () => undefined;
    const linePromise = new Promise<string>((res, rej) => { resolveLine = res; rejectLine = rej; });
    const clipboard = copyPromisedText(linePromise);
    try {
      const d = draft.current;
      d.projectId ??= (await ensureProject()) ?? undefined;
      if (!d.projectId) { rejectLine(new Error('project')); fail('project'); return; }
      await fetchWithAuth('/api/current-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: d.projectId }),
      }).catch(() => null);
      if (!d.agentId) {
        const agentRes = await fetchWithAuth('/api/team-members', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: orgId, project_id: d.projectId, type: 'agent', name: t('defaultAgent'), role: 'developer' }),
        });
        if (!agentRes.ok) { rejectLine(new Error('agent')); fail('agent'); return; }
        const agentJson = (await agentRes.json().catch(() => null)) as { data?: { id: string; api_key?: string } } | null;
        d.agentId = agentJson?.data?.id;
        d.key = isPlainKey(agentJson?.data?.api_key) ? agentJson!.data!.api_key! : undefined;
      }
      // the agent exists from here on: a retry resumes with it (never a second agent) — and asks for a key if the first answer carried none
      if (!d.agentId) { rejectLine(new Error('agent')); fail('key'); return; }
      d.key ??= (await issueKey(d.agentId)) ?? undefined;
      if (!d.key) { rejectLine(new Error('key')); fail('key'); return; }
      const mcpUrl = await hostedAddress(d.agentId);
      if (!mcpUrl) { rejectLine(new Error('hosted')); fail('hosted'); return; }
      const next: Made = { projectId: d.projectId, agentId: d.agentId, key: d.key, mcpUrl };
      resolveLine(lineFor(next, runtime, false));
      setMade(next);
      setRevoked(false);
      setPhase('ready');
      const result = await clipboard;
      if (result.ok) {
        setCopyFailedLine(null);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        emitOnboardingEvent('config_copied', { agent_id: next.agentId, flow: 'onboarding' });
      } else {
        setCopied(false);
        setCopyFailedLine(lineFor(next, runtime, false));
      }
    } catch {
      rejectLine(new Error('network'));
      fail('network');
    } finally {
      onWorking?.(false);
    }
  };

  /** a new key for the same agent (after the first was revoked) — the line is rebuilt and copied again */
  const rekey = async () => {
    if (!made || phase === 'working') return;
    setPhase('working');
    setFailure(null);
    onWorking?.(true);
    try {
      const key = await issueKey(made.agentId);
      if (!key) { fail('key'); return; }
      draft.current.key = key;
      const next: Made = { ...made, key };
      setMade(next);
      setRevoked(false);
      setRevokeFailed(false);
      setPhase('ready');
      await copyLine(next, runtime);
    } catch {
      fail('network');
    } finally {
      onWorking?.(false);
    }
  };

  /** [키 폐기]: every live key of this agent (there is one — the one just made) */
  const revoke = async () => {
    if (!made || revoking) return;
    setRevoking(true);
    setRevokeFailed(false);
    try {
      const listed = await fetchWithAuth(`/api/agents/${made.agentId}/api-key`);
      if (!listed.ok) throw new Error('list');
      const body = (await listed.json()) as { data?: { id: string; revoked_at?: string | null }[] };
      const live = (body.data ?? []).filter((k) => !k.revoked_at);
      const results = await Promise.all(live.map((k) => fetchWithAuth(`/api/agents/${made.agentId}/api-key/${k.id}`, { method: 'DELETE' })));
      if (results.some((r) => !r.ok)) throw new Error('revoke');
      setRevoked(true);
      setCopyFailedLine(null);
    } catch {
      setRevokeFailed(true);
    } finally {
      setRevoking(false);
    }
  };

  const rail = useVerificationRail({
    agentId: made?.agentId ?? null,
    transport: 'http',
    enabled: phase === 'ready' && !revoked,
    configCopiedDone: copied || phase === 'ready',
  });

  const firstInstruction = async () => {
    if (!made || startingInstruction) return;
    setStartingInstruction(true);
    try {
      const convId = await createFirstInstructionConversation(made.projectId, made.agentId);
      if (!convId) { onFinish(); return; }
      await refreshAuthTokens().catch(() => null);
      window.location.href = withProjectParam(`/chats/${convId}`, made.projectId);
    } catch {
      onFinish();
    } finally {
      setStartingInstruction(false);
    }
  };

  const copyInstall = async (rt: ConnectRuntime) => {
    const result = await copyTextSafely(INSTALL[rt]);
    if (result.ok) { setInstallCopied(rt); setTimeout(() => setInstallCopied((cur) => (cur === rt ? null : cur)), 2000); }
  };

  const shownLine = made ? lineFor(made, runtime, true) : null; // drawn only inside the `made && !revoked` block below
  const failureText: Record<Failure, string> = {
    network: t('failure.network'), project: t('failure.project'), agent: t('failure.agent'), key: t('failure.key'), hosted: t('failure.hosted'),
  };
  const keyLine = made
    ? (runtime === 'claude' ? t('keyLineClaude', { key: maskKey(made.key), file: CLAUDE_SETTINGS_FILE }) : t('keyLineCodex', { key: maskKey(made.key), env: CODEX_KEY_ENV }))
    : '';
  const nextLine = runtime === 'claude' ? t('nextClaude', { sentence, yes: CLAUDE_TRUST_YES }) : t('nextCodex', { sentence });

  return (
    <div className="space-y-3" data-testid="advanced-connect">
      <p className="break-keep text-xs text-muted-foreground">{t('lead')}</p>

      {/* AC4 (D5): what the program needs — the web cannot see this computer, so no «status»; the install lines are the app setup's own */}
      <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3" data-testid="advanced-prereq">
        <p className="break-keep text-xs font-medium text-foreground">{t('prereqTitle')}</p>
        <p className="break-keep text-xs text-muted-foreground">{t('prereqBody')}</p>
        <ul className="space-y-1">
          {(['claude', 'codex'] as const).map((rt, i) => (
            <li key={rt} className="flex flex-wrap items-center gap-2" data-testid={`advanced-install-${rt}`}>
              <span className="w-24 shrink-0 text-xs text-foreground">{RUNTIME_LABEL[rt]}</span>
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs text-foreground">{INSTALL[rt]}</code>
              <Button variant="outline" size="sm" onClick={() => void copyInstall(rt)} data-testid={`advanced-install-copy-${rt}`} aria-label={t('installCopyAria', { n: i + 1, label: RUNTIME_LABEL[rt] })}>
                {installCopied === rt ? <><Check className="h-3.5 w-3.5" />{t('copied')}</> : <><Copy className="h-3.5 w-3.5" />{t('copy')}</>}
              </Button>
            </li>
          ))}
        </ul>
        <p className="break-keep text-xs text-muted-foreground" data-testid="advanced-prereq-app">{t('prereqApp')}</p>
      </div>

      {phase !== 'ready' || revoked ? (
        <div className="space-y-1.5">
          <Button
            variant="glass"
            size="lg"
            className="w-full"
            onClick={() => void (revoked ? rekey() : make())}
            disabled={phase === 'working' || !orgId}
            data-testid="advanced-make"
          >
            {phase === 'working'
              ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('making')}</>
              : revoked ? t('remake') : <><Terminal className="h-4 w-4" aria-hidden />{t('make')}</>}
          </Button>
          {revoked ? <p role="status" className="break-keep text-xs text-foreground" data-testid="advanced-revoked">{t('revokedNote')}</p> : null}
          {phase === 'failed' && failure ? (
            <p role="alert" className="break-keep text-xs text-destructive" data-testid="advanced-failed">{failureText[failure]}</p>
          ) : null}
        </div>
      ) : null}

      {made && !revoked ? (
        <div className="space-y-2" data-testid="advanced-ready">
          <div className="flex gap-0 rounded-md border border-border bg-muted p-[3px]" role="group" aria-label={t('runtimeLabel')}>
            {(['claude', 'codex'] as const).map((rt, i) => (
              <Button
                key={rt}
                type="button"
                variant={runtime === rt ? 'secondary' : 'ghost'}
                size="sm"
                data-testid={`advanced-runtime-${rt}`}
                aria-pressed={runtime === rt}
                aria-label={t('choiceAria', { n: i + 1, label: RUNTIME_LABEL[rt] })}
                onClick={() => { setRuntime(rt); setCopied(false); setCopyFailedLine(null); }}
                className="flex-1"
              >
                {RUNTIME_LABEL[rt]}
              </Button>
            ))}
          </div>

          <div className={cn(cardVariants(), 'overflow-hidden')}>
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
              <span className="text-xs text-foreground">{t('lineLabel')}</span>
              <Button variant="outline" size="sm" onClick={() => void copyLine(made, runtime)} data-testid="advanced-copy" className="shrink-0 whitespace-nowrap">
                {copied ? <><Check className="h-3.5 w-3.5" />{t('copied')}</> : <><Copy className="h-3.5 w-3.5" />{t('copy')}</>}
              </Button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all bg-muted/40 p-3 font-mono text-xs leading-relaxed" data-testid="advanced-line">{shownLine}</pre>
          </div>


          {/* the key's places, by name — the same place as the revoke button (Kadir's lens (1)) */}
          <div className="flex flex-wrap items-start gap-2 rounded-md border border-warning-border bg-warning-tint px-3 py-2.5 text-xs text-foreground" data-testid="advanced-key-line">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 break-keep">{keyLine}</span>
            <Button variant="outline" size="sm" onClick={() => void revoke()} disabled={revoking} data-testid="advanced-revoke" className="shrink-0 whitespace-nowrap">
              {revoking ? t('revoking') : t('revoke')}
            </Button>
            {revokeFailed ? <p role="alert" className="w-full break-keep text-foreground" data-testid="advanced-revoke-failed">{t('revokeFailed')}</p> : null}
          </div>

          {/* the clipboard refused: the real line is not drawn until the person asks for it — here, right under the key's warning */}
          {copyFailedLine ? (
            <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive-tint p-3">
              <p role="alert" className="break-keep text-xs text-foreground">{t('copyFailed')}</p>
              {rawShownFor === copyFailedLine ? (
                <textarea
                  readOnly
                  value={copyFailedLine}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full resize-none rounded border border-border bg-background p-2 font-mono text-base text-foreground lg:text-xs"
                  rows={4}
                  data-testid="advanced-copy-failed-raw"
                />
              ) : (
                <Button variant="outline" size="sm" onClick={() => setRawShownFor(copyFailedLine)} data-testid="advanced-show-command">
                  {t('showCommand')}
                </Button>
              )}
            </div>
          ) : null}

          <p className="break-keep text-xs text-muted-foreground" data-testid="advanced-next">{nextLine}</p>

          <div className="space-y-2 border-t border-border pt-3" data-testid="advanced-verify">
            <VerifyRail steps={rail.displaySteps} />
            {rail.awaitingVerification && !rail.timedOut ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
                {tOnb('verifyWaiting')}
              </p>
            ) : null}
            {rail.timedOut ? (
              <div role="status" className="rounded-md border border-info-border bg-info-tint px-3 py-2.5 text-xs text-foreground" data-testid="advanced-timeout">
                <p className="font-medium">{tOnb('verifyTimeoutTitle')}</p>
                <p className="mt-1">{t('timeoutHint')}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void rail.handleVerify()} disabled={rail.verifying} data-testid="advanced-retest">
                  {tOnb('verifyRetry')}
                </Button>
              </div>
            ) : null}
            {rail.verified ? (
              <div role="status" aria-live="polite" className="rounded-md border border-success/20 bg-success/10 px-3 py-2.5 text-sm text-foreground" data-testid="advanced-verified">
                {rail.firstCallAt
                  ? tOnb.rich('verifiedBannerAt', { t: () => <time dateTime={rail.firstCallAt!}><ViewerDate value={rail.firstCallAt!} options={VIEWER_TIME_OPTIONS} /></time> })
                  : tOnb('verifiedBanner')}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onFinish} data-testid="advanced-finish">
                {todayV3Enabled ? tOnb('desktopFinishToToday') : tOnb('dashboardCta')}
              </Button>
              <Button variant="glass" size="sm" onClick={() => void firstInstruction()} disabled={startingInstruction} data-testid="advanced-first-instruction">
                {tOnb('firstInstructionCta')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
