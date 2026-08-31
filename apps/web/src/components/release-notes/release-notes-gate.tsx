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

export interface ReleaseNotesGateDecision {
  /** true면 모달을 연다. */
  shouldOpen: boolean;
  /** null 아니면 localStorage에 이 값을 즉시 seen으로 기록한다(모달 오픈 여부와 무관 —
   * 「첫 로드 캐치업 억제」 케이스는 열지 않으면서도 기록은 한다). */
  writeSeenAs: string | null;
}

/**
 * story #3196 ① — 순수함수로 뽑아 mount 없이 단위테스트 가능하게 한다(chat-view.tsx의
 * mergeBackfilledMessages 등과 동형 관례). `seen`(localStorage 저장값)과 `latest`(서버
 * 최신 노트 id)만으로 판단.
 *
 * `seen === null`은 두 가지를 구분 못 한다 — "이 계정이 여태 아무 노트도 안 봄"(정상
 * catch-up 대상)과 "가입 시점의 이 브라우저가 아직 이 gate를 한 번도 안 거침"(신규 계정의
 * 첫 세션 — 가입 前 릴리스는 이 사람에게 «새 소식»이 아니다). 가입 시각을 모르므로 정확히
 * 가르진 못하지만, "첫 로드"(seen===null) 자체를 캐치업 억제 신호로 쓴다 — 조용히
 * latest를 seen으로 기록만 하고 모달은 안 연다. 그 다음부터 실제로 새 노트가 나오면(seen이
 * 그 값보다 오래됨, 즉 seen!==latest이면서 seen이 null이 아님) 정상 오픈 — 억제되는 건
 * "가입 前 누적분 첫 노출"뿐, 이후 신규 소식은 무회귀.
 */
export function decideReleaseNotesGate(seen: string | null, latest: string | null): ReleaseNotesGateDecision {
  if (!latest) return { shouldOpen: false, writeSeenAs: null };
  if (seen === null) return { shouldOpen: false, writeSeenAs: latest };
  if (seen !== latest) return { shouldOpen: true, writeSeenAs: null };
  return { shouldOpen: false, writeSeenAs: null };
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
        const key = seenKey(userId);
        const seen = localStorage.getItem(key);
        const latest = fetched[0]?.id ?? null;
        const decision = decideReleaseNotesGate(seen, latest);
        if (decision.writeSeenAs) {
          localStorage.setItem(key, decision.writeSeenAs);
          setSeenId(decision.writeSeenAs);
        } else {
          setSeenId(seen);
        }
        if (decision.shouldOpen) setOpen(true);
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
