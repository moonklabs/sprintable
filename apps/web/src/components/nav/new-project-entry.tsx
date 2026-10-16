'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { desktopApp, subscribeDesktopApp, type SprintableDesktop } from '@/lib/desktop-app';
import { appSetupLink } from '@/lib/auth/native-return-app';

/**
 * story 4713 (UX-1 · Yuna 10-16): inside the desktop app, «새 프로젝트» is one always-visible line right under the project switcher
 * (not inside its menu). It opens the same setup the app's other entries open: the page hands the shell the app's own setup link — the
 * one app link the shell takes in place (desktop-electron navigation.ts `decideNavigation` → 'app-link' · story 4427) — and the app
 * starts a setup for this person; the three steps (folder → agent → start) are the setup card's (story 4711). No new bridge hand.
 * A browser has no bridge: nothing is drawn and the switcher's menu item is the way, as before.
 */
export const NEW_PROJECT_LINK = appSetupLink(null);

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
      onClick={() => window.location.assign(NEW_PROJECT_LINK)}
      data-testid="sidebar-new-project"
    >
      <Plus className="size-3.5" aria-hidden />
      <span className="truncate">{t('switcherNewProject')}</span>
    </Button>
  );
}
