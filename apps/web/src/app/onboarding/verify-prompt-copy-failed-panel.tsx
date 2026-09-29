'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

/**
 * story #3986 CHANGES(페드루 PO C2·2회차) — 검증 예시 프롬프트 복사가 실패했을 때만 안 잘린 전체 문구를 선택 가능하게 보인다.
 * 3초로 안 자르고 다음 성공(훅이 리셋) · 바깥 클릭 · Esc · 닫기까지 유지한다.
 * story #4372 — connect-step에만 있던 이 패널을 채용 화면(recruiter-client)도 같이 쓴다. 같은 훅(useVerificationRail)의
 * `copyVerifyPromptFailed`를 채용 화면은 안 읽어 복사가 실패해도 버튼이 «복사» 그대로였다(무표시) — 두 화면이 같은 말을 하게 한 곳으로.
 */
export function VerifyPromptCopyFailedPanel({ failed, onDismiss, promptText, rawTestId }: {
  failed: boolean;
  onDismiss: () => void;
  promptText: string;
  rawTestId: string;
}) {
  const tc = useTranslations('common');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!failed) return;
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [failed, onDismiss]);

  if (!failed) return null;
  return (
    <div ref={panelRef} className="space-y-1">
      <div className="flex items-start justify-between gap-2">
        <p role="alert" className="text-xs text-destructive">{tc('copyFailedSelectManually')}</p>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label={tc('close')}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          ✕
        </Button>
      </div>
      <input
        readOnly
        value={promptText}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-base lg:text-xs text-foreground"
        data-testid={rawTestId}
      />
    </div>
  );
}
