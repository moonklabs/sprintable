'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { desktopApp, subscribeDesktopApp, type SprintableDesktop } from '@/lib/desktop-app';
import { appSetupLink } from '@/lib/auth/native-return-app';

/**
 * story 4713 (UX-1 · Yuna 10-16): inside the desktop app «새 프로젝트» is one always-visible line right under the project switcher
 * (not inside its menu). A browser has no bridge: nothing is drawn and the switcher's menu item is the way, as before.
 *
 * story 4832 (PO 11-03 «이름 = 하는 일»): the line now does what its name says — it opens the project dialog (the same one the switcher's
 * menu item opens; inside the app that dialog carries the project's folder field, 4681). Starting agents on this computer is the line
 * beneath it, `MoveAgentsEntry`: it hands the shell the app's own setup link with `intent=move` — the one app link the shell takes in
 * place (desktop-electron navigation.ts `decideNavigation` → 'app-link' · story 4427) — and the app opens its setup page with
 * «이미 있는 에이전트 옮기기» chosen. No new bridge hand.
 */
export const NEW_PROJECT_LINK = appSetupLink(null);
/** the move door's link — the setup link plus the one intent that chooses «옮기기» */
export const MOVE_AGENTS_LINK = appSetupLink(null, 'move');
/** the sidebar's «새 프로젝트» asks the shell's project switcher to open its dialog (only the sidebar's switcher listens: the top bar's chip would open a second one) */
export const OPEN_NEW_PROJECT_EVENT = 'sprintable:open-new-project';
/** the app menu's «파일 › 새 프로젝트… ⌘N»: the app puts this one flag on the page address it already shows (the app never pushes script into the web page); the sidebar's switcher opens the dialog and takes the flag off */
export const NEW_PROJECT_PARAM = 'new_project';

export function NewProjectEntry({ className }: { className?: string }) {
  const t = useTranslations('nav');
  const bridge = useSyncExternalStore<SprintableDesktop | undefined>(subscribeDesktopApp, desktopApp, () => undefined);
  if (!bridge) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => window.dispatchEvent(new Event(OPEN_NEW_PROJECT_EVENT))}
      data-testid="sidebar-new-project"
    >
      <Plus className="size-3.5" aria-hidden />
      <span className="truncate">{t('switcherNewProject')}</span>
    </Button>
  );
}

/** story 4832: «이 컴퓨터로 에이전트 옮기기» — the app's own door for starting this organization's agents on this computer. Inside the app only. */
export function MoveAgentsEntry({ className }: { className?: string }) {
  const t = useTranslations('nav');
  const bridge = useSyncExternalStore<SprintableDesktop | undefined>(subscribeDesktopApp, desktopApp, () => undefined);
  if (!bridge) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => window.location.assign(MOVE_AGENTS_LINK)}
      data-testid="sidebar-move-agents"
    >
      <Monitor className="size-3.5" aria-hidden />
      <span className="truncate">{t('moveAgentsEntry')}</span>
    </Button>
  );
}
