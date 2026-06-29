'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { fetchReleaseNotes, type ReleaseNote } from '@/lib/release-notes';
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
  const [notes, setNotes] = useState<ReleaseNote[]>([]);

  // de-hardcode(53bc0945): 노트는 API 에서 로드. 최신 노트 id = notes[0]?.id (서버 newest-first).
  const latestId = notes[0]?.id ?? null;

  // mount 後 노트 fetch + localStorage 읽기(SSR hydration 불일치 방지). 미열람 최신 노트면 auto-open.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const fetched = await fetchReleaseNotes();
      if (cancelled) return;
      setNotes(fetched);
      try {
        const seen = localStorage.getItem(seenKey(userId));
        setSeenId(seen);
        const latest = fetched[0]?.id ?? null;
        if (latest && seen !== latest) setOpen(true);
      } catch {
        // localStorage 차단 환경 — gate 무동작
      } finally {
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const markSeen = useCallback(() => {
    if (!userId || !latestId) return;
    try {
      localStorage.setItem(seenKey(userId), latestId);
    } catch {
      // ignore
    }
    setSeenId(latestId);
  }, [userId, latestId]);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => {
    markSeen();
    setOpen(false);
  }, [markSeen]);

  const hasUnseen = ready && latestId != null && seenId !== latestId;

  // userId 없으면 gate skip (셸은 인증 後라 보통 존재)
  if (!userId) return <>{children}</>;

  return (
    <ReleaseNotesContext.Provider value={{ open: handleOpen, hasUnseen }}>
      {children}
      <ReleaseNotesDialog open={open} onClose={handleClose} notes={notes} />
    </ReleaseNotesContext.Provider>
  );
}
