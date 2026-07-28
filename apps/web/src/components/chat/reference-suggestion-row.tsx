'use client';

import { useMemo, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { findReferenceCandidates, isCandidateRejected, rejectCandidate } from '@/lib/reference-candidates';

interface ReferenceSuggestionRowProps {
  messageId: string;
  content: string;
  /** AC1: 보낸 사람 본인의 메시지 바로 아래에서만 묻는다 — 남의 메시지엔 안 뜬다. */
  isMine: boolean;
}

/**
 * story #2283 — 사람이 채팅에 평문으로 친 `#번호`·`#슬러그`를 「이걸 스토리로 잇겠습니까?」로
 * 한 번 묻는다. ⛔자동 확정 금지(AC2) — 사람이 누른 것만 선다.
 *
 * ⛔해소(번호/슬러그→UUID)·확인된 참조를 실제로 꽂는 쓰기 경로 둘 다 아직 BE에 없다
 * (디디군이 #2282 다음 판에서 함께 만든다 — 착수 전 착수 보고 참조). 그래서 「예」는 지금
 * 조용히 성공한 척하지 않고 "곧 지원됩니다"를 명시적으로 보여준다 — API가 채워지면 이
 * 컴포넌트의 handleConfirm 한 곳만 실 구현으로 바꾸면 된다(자리·탐지·소음규칙은 이미 완성).
 */
export function ReferenceSuggestionRow({ messageId, content, isMine }: ReferenceSuggestionRowProps) {
  const t = useTranslations('chats');
  // AC3 ②: 거절 즉시 이 렌더 인스턴스에서도 사라지도록 로컬 상태로 미러링(localStorage는
  // 다음 마운트/새로고침 시의 진실이고, 지금 이 세션에서 즉시 반영되려면 상태가 필요하다).
  const [locallyDismissed, setLocallyDismissed] = useState<Set<string>>(() => new Set());
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!isMine) return [];
    return findReferenceCandidates(content).filter(
      (c) => !isCandidateRejected(messageId, c.raw) && !locallyDismissed.has(c.raw),
    );
  }, [isMine, content, messageId, locallyDismissed]);

  if (candidates.length === 0) return null;

  const handleReject = (raw: string) => {
    rejectCandidate(messageId, raw);
    setLocallyDismissed((prev) => new Set(prev).add(raw));
  };

  // ⛔AC2: 여기서 참조를 만들지 않는다 — BE 쓰기 경로가 서면 이 함수 본체만 교체한다.
  const handleConfirm = (raw: string) => {
    setPendingNotice(raw);
  };

  return (
    <div className="mt-1 flex flex-col gap-1">
      {candidates.map((c) => (
        <div
          key={c.raw}
          className="flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground"
        >
          <Link2 className="size-3.5 shrink-0" aria-hidden />
          {pendingNotice === c.raw ? (
            <span className="flex-1">{t('referenceCandidateComingSoon', { token: c.raw })}</span>
          ) : (
            <>
              <span className="flex-1">{t('referenceCandidatePrompt', { token: c.raw })}</span>
              <button
                type="button"
                onClick={() => handleConfirm(c.raw)}
                className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10"
              >
                {t('referenceCandidateConfirm')}
              </button>
              <button
                type="button"
                onClick={() => handleReject(c.raw)}
                aria-label={t('referenceCandidateReject')}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
