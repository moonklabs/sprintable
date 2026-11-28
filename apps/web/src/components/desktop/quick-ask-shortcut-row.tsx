'use client';

// story 5047 (C14 · PO 11-27): the quick-ask shortcut's row in the desktop settings card — the key now, where it stands, and [바꾸기]: the page listens for the next key combination, sends it to the app as text, and says what the app
// answered. The app is the one that judges (a key needs a modifier · another app may hold it) and keeps the OLD key when the new one is refused, so the row shows only what the app says it KEPT — never what it was merely asked for.
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { quickShortcutNow, writeQuickShortcut, type QuickShortcutView, type SprintableDesktop } from '@/lib/desktop-app';
import { acceleratorFromKeyPress, isModifierCode } from '@/lib/quick-shortcut-key';

type Mode = 'idle' | 'listening' | 'busy';
type Line = null | 'saved' | 'invalid' | 'conflict' | 'failed';

export function QuickAskShortcutRow({ bridge }: { bridge: SprintableDesktop }) {
  const t = useTranslations('desktop.appSettings.quickAsk');
  const [view, setView] = useState<QuickShortcutView | null>(() => quickShortcutNow(bridge));
  const [mode, setMode] = useState<Mode>('idle');
  const [line, setLine] = useState<Line>(null);
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const prevMode = useRef<Mode>('idle');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // after listening or waiting ends, the keyboard person lands back on [바꾸기] (the button they pressed is gone while listening)
  useEffect(() => {
    if (prevMode.current !== 'idle' && mode === 'idle') root.current?.querySelector<HTMLElement>('[data-testid="quick-shortcut-change"]')?.focus();
    prevMode.current = mode;
  }, [mode]);

  // while listening, the next key combination is the answer: the page takes every key (Esc cancels; a modifier alone waits for the key)
  useEffect(() => {
    if (mode !== 'listening') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return; // a key that belongs to an input method's composition is not a shortcut
      // Tab · Enter · Space with no modifier is never a shortcut (the app needs one): it keeps its own job, so a keyboard person can still reach and press [취소]
      if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'Tab' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setMode('idle'); return; }
      if (e.repeat) return; // a held key is one press: its auto-repeat is not a second answer
      if (isModifierCode(e.code)) return; // only a modifier so far: keep listening for the key
      const accelerator = acceleratorFromKeyPress(e);
      if (accelerator === null) { setLine('invalid'); setMode('idle'); return; } // a key the app has no name for (a numpad or an international key): said in words, never a silent miss
      setMode('busy');
      void writeQuickShortcut(accelerator, bridge).then((r) => {
        if (!alive.current) return; // the row is gone: nothing to draw
        if (r.kind === 'ok') { setView(r.shortcut); setLine('saved'); } else if (r.kind === 'refused') { if (r.shortcut) setView(r.shortcut); setLine(r.code); } else setLine('failed');
        setMode('idle');
      });
    };
    const onBlur = (): void => setMode('idle'); // the person left the window: the next key they press there is not an answer
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', onBlur); };
  }, [mode, bridge]);

  if (!view) return null;
  const statusText = { registered: t('statusRegistered'), conflict: t('statusConflict'), failed: t('statusFailed'), off: t('statusOff') }[view.status];
  const message = { saved: t('saved'), invalid: t('invalid'), conflict: t('conflictTried'), failed: t('failedTried') };

  return (
    <div ref={root} className="space-y-2" data-testid="quick-shortcut-row">
      <h3 className="text-ds-body font-semibold text-ds-ink-2">{t('title')}</h3>
      <p className="text-ds-small text-ds-ink-3">{t('note')}</p>
      {view.status === 'registered' ? <p className="text-ds-small text-ds-ink-3" data-testid="quick-shortcut-hint">{t('registeredHint')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ds-body text-ds-ink" data-testid="quick-shortcut-label">{t('current', { key: view.label })}</span>
        <span className={view.status === 'registered' ? 'text-ds-small text-ds-ink-3' : 'text-ds-small text-ds-failed'} data-testid="quick-shortcut-status">{statusText}</span>
        {mode === 'idle' ? <Button onClick={() => { setLine(null); setMode('listening'); }} aria-label={t('changeAria')} data-testid="quick-shortcut-change">{t('change')}</Button> : null}
        {mode === 'listening' ? <Button variant="quiet" onClick={() => setMode('idle')} aria-label={t('cancelAria')} data-testid="quick-shortcut-cancel">{t('cancel')}</Button> : null}
      </div>
      {mode === 'listening' ? <p className="text-ds-body text-ds-ink" role="status" data-testid="quick-shortcut-listening">{t('listening')}</p> : null}
      {mode === 'busy' ? <p className="text-ds-small text-ds-ink-3" role="status">{t('busy')}</p> : null}
      {line && mode === 'idle' ? <div data-testid="quick-shortcut-line"><Banner tone={line === 'saved' ? 'info' : 'failed'}>{message[line]}</Banner></div> : null}
    </div>
  );
}
