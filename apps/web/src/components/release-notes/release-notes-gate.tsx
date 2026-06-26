'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { LATEST_RELEASE_NOTE_ID } from '@/lib/release-notes';
import { ReleaseNotesDialog } from './release-notes-dialog';

interface ReleaseNotesContextValue {
  open: () => void;
  hasUnseen: boolean;
}

const ReleaseNotesContext = createContext<ReleaseNotesContextValue | null>(null);

/** top-bar 버튼 등 consumer. provider 밖이면 null → 버튼은 렌더 안 함. */
export function useReleaseNotes(): ReleaseNotesContextValue | null {
  return useContext(ReleaseNotesContext);
}

function seenKey(userId: string): string {
  return `sprintable.releaseNotes.seen.${userId}`;
}

interface ReleaseNotesProviderProps {
  userId?: string;
  children: React.ReactNode;
}

export function ReleaseNotesProvider({ userId, children }: ReleaseNotesProviderProps) {
  const [open, setOpen] = useState(false);
  const [seenId, setSeenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // mount 後 localStorage 읽기 (SSR hydration 불일치 방지). 미열람 최신 노트면 auto-open.
  useEffect(() => {
    if (!userId) return;
    try {
      const seen = localStorage.getItem(seenKey(userId));
      setSeenId(seen);
      if (LATEST_RELEASE_NOTE_ID && seen !== LATEST_RELEASE_NOTE_ID) setOpen(true);
    } catch {
      // localStorage 차단 환경 — gate 무동작
    } finally {
      setReady(true);
    }
  }, [userId]);

  const markSeen = useCallback(() => {
    if (!userId || !LATEST_RELEASE_NOTE_ID) return;
    try {
      localStorage.setItem(seenKey(userId), LATEST_RELEASE_NOTE_ID);
    } catch {
      // ignore
    }
    setSeenId(LATEST_RELEASE_NOTE_ID);
  }, [userId]);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => {
    markSeen();
    setOpen(false);
  }, [markSeen]);

  const hasUnseen = ready && LATEST_RELEASE_NOTE_ID != null && seenId !== LATEST_RELEASE_NOTE_ID;

  // userId 없으면 gate skip (셸은 인증 後라 보통 존재)
  if (!userId) return <>{children}</>;

  return (
    <ReleaseNotesContext.Provider value={{ open: handleOpen, hasUnseen }}>
      {children}
      <ReleaseNotesDialog open={open} onClose={handleClose} />
    </ReleaseNotesContext.Provider>
  );
}
