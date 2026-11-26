'use client';

/**
 * story 5031 (C1 step 3) — ⌘1 · ⌘2 · ⌘3 · ⌘4 (Ctrl on Windows / Linux) open the four places 홈 · 채팅 · 에이전트 · 설정 (lib/nav-depth1: DEPTH1_ITEMS, first screen of each).
 * Mounted once by the shell (dashboard-shell ShellBody), next to the icon bar that names the keys in its titles. The keys are listed in lib/keyboard-shortcuts.ts (a shortcut hint is drawn only where a handler exists);
 * keyboard-shortcuts.test.ts reads THIS file for the keydown handling and each key.
 * Rules: Cmd or Ctrl and nothing else (Shift / Alt keep their own meanings) · not while a contentEditable surface is focused (same rule as ⌘K) · a text field does not stop it (⌘1–⌘4 are not text) ·
 * the page is not left twice (pressing the key of the place you are in is a no-op navigation: router.push of the same path).
 * In a plain browser the browser itself takes ⌘1–⌘4 for its tabs before the page sees them — harmless; in the desktop app (the web in a window) the page gets them.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { depth1ByShortcut } from '@/lib/nav-depth1';
import { useFlatHref } from '@/hooks/use-flat-href';

export function useDepth1Shortcuts(): void {
  const router = useRouter();
  const flatHref = useFlatHref();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!['1', '2', '3', '4'].includes(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      const place = depth1ByShortcut(event.key);
      if (!place) return;
      event.preventDefault();
      router.push(flatHref(place.path));
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [router, flatHref]);
}
