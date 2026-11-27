'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Chip } from '@/components/ds/chip';
import { loadQuickTargets, quickSend, type TargetsResult } from '@/lib/quick/quick-api';
import { parsePost, parseQuickState, quickBridge, type QuickBridge, type QuickTargetView, type QuickViewState } from '@/lib/quick/quick-view';

// story 5047 (C14 · PO 11-27): the quick-ask window's page. A line of one row: who it goes to (a chip), the words, and — when the person asks — a small picture of the window in front.
// The STATE is the app's (it decides when the window closes: only after the server answered 2xx); this page draws what it is given and reports what the person did.
// Nothing here navigates, opens a link or keeps a copy of the words.

type Loaded = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; projectId: string; targets: QuickTargetView[] } | { status: 'login' } | { status: 'failed' };

/** the message for each failure, by LITERAL key (the dead-key guard reads literals, not `failure.${…}`) */
const FAILURE_KEY: Record<string, string> = { rejected: 'failure.rejected', server: 'failure.server', offline: 'failure.offline' };

const matches = (t: QuickTargetView, q: string): boolean => q.trim() === '' || t.name.toLowerCase().includes(q.trim().toLowerCase());

export function QuickAsk() {
  const t = useTranslations('quick');
  const bridge = useMemo<QuickBridge | null>(() => quickBridge(), []);
  const [view, setView] = useState<QuickViewState | null>(null);
  // one number per opening of the window: the places are read once per opening, and an answer belongs to the opening that asked (no state is set from the effect body — only from the answer)
  const [openCount, setOpenCount] = useState(0);
  const [answer, setAnswer] = useState<{ count: number; result: TargetsResult } | null>(null);
  const wasOpen = useRef(false);
  // the highlighted place: an index that belongs to the (phase · query) it was moved in — a new query starts again at the first place without an effect resetting it
  const [cursorAt, setCursorAt] = useState<{ key: string; i: number }>({ key: '', i: 0 });
  const cursorKey = `${view?.phase ?? ''}|${view?.pickQuery ?? ''}`;
  const cursor = cursorAt.key === cursorKey ? cursorAt.i : 0;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const projectRef = useRef<string | null>(null);

  const send = useCallback((e: Record<string, unknown>) => { void bridge?.event(e); }, [bridge]);
  // Esc asks the app to take ONE layer away: the list of places if it is open, else the window (the app decides which, and when it may close — only the app knows if a send is going)
  const closeOneLayer = useCallback((): void => { send({ type: 'escape' }); }, [send]);

  // the app's state in · the app's request out
  useEffect(() => {
    if (!bridge) return;
    const offState = bridge.onState((raw) => {
      const s = parseQuickState(raw);
      if (!s) return;
      // the window just opened: the project read for the last opening is not this one's (the person may have switched projects meanwhile) — a send before the new read lands asks the server again (codex 5047)
      if (s.open && !wasOpen.current) { projectRef.current = null; setOpenCount((c) => c + 1); }
      wasOpen.current = s.open;
      setView(s);
    });
    const offPost = bridge.onPost((raw) => {
      const post = parsePost(raw);
      // a request that cannot be read is answered as a refusal, never left for the app to wait out
      if (!post) { send({ type: 'send-result', status: 422 }); return; }
      void quickSend(post, projectRef.current).then((status) => send({ type: 'send-result', status }));
    });
    bridge.ready();
    return () => { offState(); offPost(); };
  }, [bridge, send]);

  // the places to send are read when the window opens (a project's agents change)
  const open = view?.open === true;
  useEffect(() => {
    if (openCount === 0) return;
    let live = true;
    void loadQuickTargets().then((r: TargetsResult) => {
      if (!live) return;
      if (r.ok) projectRef.current = r.projectId;
      setAnswer({ count: openCount, result: r });
    });
    return () => { live = false; };
  }, [openCount]);
  const loaded = useMemo<Loaded>(() => !open || openCount === 0 ? { status: 'idle' } : answer?.count !== openCount ? { status: 'loading' } : answer.result.ok ? { status: 'ready', projectId: answer.result.projectId, targets: answer.result.targets } : { status: answer.result.reason === 'login' ? 'login' : 'failed' }, [open, openCount, answer]);

  useEffect(() => { if (open && view?.phase !== 'sending') input.current?.focus(); }, [open, view?.phase]);

  // the window is as tall as what is drawn (the app keeps it within bounds)
  useEffect(() => {
    const el = root.current;
    if (!el || !bridge) return;
    const report = (): void => bridge.resize(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [bridge]);

  const list = useMemo(() => (loaded.status === 'ready' && view ? loaded.targets.filter((x) => matches(x, view.pickQuery)) : []), [loaded, view]);

  if (!bridge) return <p className="p-4 text-ds-body text-ds-ink-3" data-testid="quick-no-bridge">{t('onlyInApp')}</p>;
  if (!view || !view.open) return <div ref={root} className="h-0" />;

  const picking = view.phase === 'picking';
  const sending = view.phase === 'sending';
  const loginNeeded = view.phase === 'login' || loaded.status === 'login';
  const failureLine = view.failure && view.failure !== 'login' ? t(FAILURE_KEY[view.failure]) : null;
  // a send whose answer never came («offline») may have gone through: the same line sent again could arrive twice, so neither Enter nor the button sends it BLINDLY — editing the words or pressing «그래도 다시 보내기» is a choice (codex 5047)
  const blindRetry = view.phase === 'failed' && view.failure === 'offline';
  const value = picking ? `@${view.pickQuery}` : view.text;
  const targetName = (x: QuickTargetView): string => x.name || t('channelFallback');

  const onChange = (v: string): void => {
    if (picking) { if (v === '' || !v.startsWith('@')) send({ type: 'escape' }); else send({ type: 'pick-query', value: v.slice(1) }); return; }
    // «@» at the start of a word opens the list of places; the «@» itself is not part of the words
    if (v.endsWith('@') && (v.length === 1 || /\s/.test(v[v.length - 2]!))) { send({ type: 'text', value: v.slice(0, -1) }); send({ type: 'pick-start' }); return; }
    send({ type: 'text', value: v });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return; // a Korean syllable still being composed is not a command
    if (e.key === 'Escape') { e.preventDefault(); closeOneLayer(); return; }
    if (picking) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCursorAt({ key: cursorKey, i: Math.min(cursor + 1, Math.max(list.length - 1, 0)) }); } else if (e.key === 'ArrowUp') { e.preventDefault(); setCursorAt({ key: cursorKey, i: Math.max(cursor - 1, 0) }); } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = list[cursor];
        if (pick) send({ type: 'pick', target: pick });
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!blindRetry) send({ type: 'send' }); }
  };

  const attachOn = view.attach.kind === 'ready' || view.attach.kind === 'capturing';

  return (
    <div ref={root} className="flex flex-col bg-ds-surface text-ds-ink" data-testid="quick-root" data-phase={view.phase}>
      <div className="flex min-h-ds-control items-center gap-2 px-3 py-1">
        {view.target && !picking ? (
          <span className="max-w-[45%] shrink-0" data-testid="quick-chip"><Chip className="max-w-full"><span className="truncate">@{targetName(view.target)}</span></Chip></span>
        ) : null}
        {/* 16px under the lg width (small-text-input guard: a text box under 16px is zoomed by iOS WebKit on focus) — the window is 560 wide, so always 16; `lg:` keeps the body size where the page is wider */}
        <input
          ref={input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
          placeholder={t('placeholder')}
          aria-label={t('inputLabel')}
          role="combobox"
          aria-expanded={picking}
          aria-controls="quick-places"
          aria-activedescendant={picking && list[cursor] ? `quick-place-${list[cursor]!.kind}-${list[cursor]!.id}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-base text-ds-ink outline-none placeholder:text-ds-ink-3 disabled:text-ds-ink-3 lg:text-ds-body"
          data-testid="quick-input"
          autoComplete="off"
          spellCheck={false}
        />
        {sending ? <span className="shrink-0 text-ds-small text-ds-ink-3" data-testid="quick-sending">{t('sending')}</span> : null}
      </div>

      {picking ? (
        <div className="border-t border-ds-line">
          {loaded.status === 'login' ? (
            <div className="px-3 py-2" data-testid="quick-login"><Banner tone="info" action={<Button onClick={() => send({ type: 'open-main' })}>{t('openApp')}</Button>}>{t('loginNeeded')}</Banner></div>
          ) : null}
          {loaded.status === 'loading' ? <p role="status" className="px-3 py-2 text-ds-small text-ds-ink-3">{t('loading')}</p> : null}
          {loaded.status === 'failed' ? <p role="status" className="px-3 py-2 text-ds-body text-ds-ink">{t('loadFailed')}</p> : null}
          {loaded.status === 'ready' && list.length === 0 ? <p role="status" className="px-3 py-2 text-ds-small text-ds-ink-3">{t('noMatch')}</p> : null}
          {list.length > 0 ? (
            <ul id="quick-places" role="listbox" aria-label={t('placesLabel')} className="max-h-72 overflow-y-auto py-1" data-testid="quick-places">
              {list.map((x, i) => (
                <li
                  key={`${x.kind}-${x.id}`}
                  id={`quick-place-${x.kind}-${x.id}`}
                  role="option"
                  aria-selected={i === cursor}
                  onMouseDown={(e) => { e.preventDefault(); send({ type: 'pick', target: x }); }}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-ds-body ${i === cursor ? 'bg-ds-surface-high font-medium' : ''}`}
                >
                  <span className="min-w-0 truncate">{targetName(x)}</span>
                  <span className="shrink-0 text-ds-small text-ds-ink-3">{x.kind === 'agent' ? t('kindAgent') : t('kindChannel')}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {!picking ? (
        <div className="flex flex-col gap-2 border-t border-ds-line px-3 py-2">
          {loginNeeded ? (
            <div data-testid="quick-login"><Banner tone="info" action={<Button onClick={() => send({ type: 'open-main' })}>{t('openApp')}</Button>}>{t('loginNeeded')}</Banner></div>
          ) : null}
          {failureLine ? (
            <div data-testid="quick-failure"><Banner tone="failed" action={<Button onClick={() => send({ type: 'send' })}>{blindRetry ? t('retryAnyway') : t('retry')}</Button>}>{failureLine}</Banner></div>
          ) : null}
          {view.phase === 'discard' ? <div data-testid="quick-discard"><Banner tone="note">{t('discard')}</Banner></div> : null}

          <div className="flex items-center justify-between gap-3">
            <Checkbox label={t('attachLabel')} checked={attachOn} disabled={sending} onCheckedChange={() => send({ type: 'attach-toggle' })} data-testid="quick-attach" />
            <span className="min-w-0 text-right text-ds-small text-ds-ink-3" data-testid="quick-hint">{view.target ? t('hintReady') : t('hintNoTarget')}</span>
          </div>

          {view.attach.kind === 'denied' ? (
            <div data-testid="quick-denied"><Banner tone="note" action={<Button onClick={() => send({ type: 'open-screen-settings' })}>{t('openSettings')}</Button>}>{t('attachDenied')}</Banner></div>
          ) : null}
          {view.attach.kind === 'capturing' ? <p className="text-ds-small text-ds-ink-3" data-testid="quick-capturing">{t('capturing')}</p> : null}
          {view.attach.kind === 'ready' ? (
            <div className="flex items-center gap-3" data-testid="quick-preview">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: image the app captured; nothing is fetched */}
              <img src={view.attach.preview.dataUrl} alt={t('previewAlt')} className="h-14 w-24 shrink-0 rounded-ds-control border border-ds-line object-cover object-top" />
              <span className="min-w-0 flex-1 truncate text-ds-small text-ds-ink">{view.attach.preview.label}</span>
              <Button variant="quiet" disabled={sending} onClick={() => send({ type: 'attach-remove' })}>{t('removePicture')}</Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
