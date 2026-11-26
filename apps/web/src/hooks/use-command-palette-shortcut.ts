'use client';

/**
 * story 5032 (C2 · PO 11-27, found by the C8 lane) — ⌘K (Ctrl+K on Windows / Linux) opens the command palette. The binding used to live INSIDE the old sidebar component (app-sidebar.tsx): it worked only while the shell
 * still mounted AppSidebar, and a change that takes AppSidebar out of the shell would have removed ⌘K without a sound. It now sits with the shell, next to ⌘1–⌘4 (use-depth1-shortcuts), mounted once by dashboard-shell
 * ShellBody. lib/keyboard-shortcuts.ts lists the key against THIS file and keyboard-shortcuts.test.ts reads it; use-command-palette-shortcut.test.tsx pins «the key toggles the palette».
 * Rules (unchanged from the sidebar's): Cmd or Ctrl + K (any case) · not while a contentEditable surface is focused · the key toggles (a second press closes).
 */
import { useEffect } from 'react';
import { useCommandPalette } from '@/components/command-palette/command-palette-context';

export function useCommandPaletteShortcut(): void {
  const { setOpen } = useCommandPalette();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      event.preventDefault();
      setOpen((prev) => !prev);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpen]);
}
