'use client';
// [SID:4681] (UX-1 · D3 · piece ③ · design minh/4681-piece3-design.md §A · Yuna §H) — the «이 컴퓨터의 폴더» field of the new-project
// dialog, drawn ONLY inside the desktop app (D1 4679: `desktopApp()` is undefined in a browser → the field is not there at all · AC3).
// The page never names a folder itself: [폴더 고르기] opens the app's own chooser (`pickFolder`, a folder inside home or null), the
// picked path is shown (home as `~`, the middle elided, the full path in title) with [지우기]; null (canceled · refused) changes
// nothing. The hook keeps the folder on this Mac right after the project is made (`setProjectFolder`) — see use-unified-switcher.
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { desktopApp, pickFolderTrace } from '@/lib/desktop-app';
import { useFolderTraces } from '@/components/desktop/use-folder-traces';
import { homeAsTilde } from '@/lib/home-tilde';

/** the path as the person reads it: `/Users/<name>` as `~` (homeAsTilde), the middle elided when long — the last folder's name always stays */
export function displayFolder(path: string, max = 44): string {
  const tilde = homeAsTilde(path);
  if (tilde.length <= max) return tilde;
  const last = tilde.slice(tilde.lastIndexOf('/'));
  const head = tilde.slice(0, Math.max(max - last.length - 1, 4));
  return `${head}…${last}`;
}

export function ProjectFolderField({ value, onChange, disabled = false, idPrefix }: {
  value: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
  /** the dialog's own prefix (two dialogs may mount — sidebar · chip) so ids never collide */
  idPrefix: string;
}) {
  const t = useTranslations('nav');
  const [picking, setPicking] = useState(false);
  const app = desktopApp();
  // story 4693 (UX-1 · D4): the folder just picked — does it carry CLAUDE.md / AGENTS.md? The app answers only about a folder this page picked
  // through its own chooser (never a path the page names); an older app · a browser · no trace → no line. No agent ids asked (the project does not exist yet).
  const says = useFolderTraces(app?.folderTraces, value ? { path: value } : null, []);
  const trace = says && app ? pickFolderTrace(says.traces, app.runtimes) : undefined;
  if (!app) return null;

  const pick = async () => {
    setPicking(true);
    try {
      const picked = await app.pickFolder();
      if (picked) onChange(picked);
      // null = canceled or refused: nothing changes (the app says why when the folder is kept — the hook's notice)
    } catch {
      // a chooser that threw is the same as a canceled one here: nothing changes
    } finally {
      setPicking(false);
    }
  };

  const labelId = `${idPrefix}-folder-label`;
  return (
    <div className="space-y-1" data-testid="project-folder-field">
      <p id={labelId} className="text-sm font-medium">
        {t('switcherFolderLabel')} <span className="text-muted-foreground text-xs">{t('switcherOptionalLabel')}</span>
      </p>
      <p className="text-xs text-muted-foreground">{t('switcherFolderHint')}</p>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled || picking} aria-describedby={labelId} onClick={() => void pick()} data-testid="project-folder-pick">
          {t('switcherFolderPick')}
        </Button>
        {value && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(null)} data-testid="project-folder-clear">
            {t('switcherFolderClear')}
          </Button>
        )}
      </div>
      {/* Yuna 5067 ①: the path on its own line under the buttons (the dialog's content width holds the 44-character display); `break-all`,
          never `truncate` — a CSS end-cut would drop the last folder's name, the one part displayFolder keeps */}
      {value && (
        <code className="block break-all rounded bg-muted px-2 py-1 text-xs" title={value} data-testid="project-folder-path">{displayFolder(value)}</code>
      )}
      {/* Yuna 4693 ④: information only (no button — the project does not exist yet), under the path; it follows the value (a new pick asks again · [지우기] drops it) */}
      {value && trace && (
        <p className="text-xs text-muted-foreground break-keep" data-testid="project-folder-trace">{t('switcherFolderTrace', { file: trace.file })}</p>
      )}
    </div>
  );
}
