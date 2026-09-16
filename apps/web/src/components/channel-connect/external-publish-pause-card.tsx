'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3953(마케팅·안전장치·블루프린트 §1-5, 페드루 PO 確定 2026-09-16) — 조직
 * 전체 「외부 발행 일시 중지」 스위치. GET은 member 이상 열람(BE — 중지 여부는
 * 비밀이 아니다), PUT은 owner만(admin·에이전트 키 403).
 *
 * 문구는 초안(유나 §⑤ 판정 전 임시) — 「무슨 일 — 무엇을 하라」형·해요체·내부어 0
 * 원칙만 맞춰뒀다. design 리뷰에서 전→후가 오면 그대로 교체.
 */
interface PauseState {
  paused: boolean;
  paused_at: string | null;
  paused_by: string | null;
  reason: string | null;
}

export function ExternalPublishPauseCard({ orgId, isOwnerStrict }: { orgId: string; isOwnerStrict: boolean }) {
  const t = useTranslations('channelConnect');
  const [state, setState] = useState<PauseState | null>(null);
  const [reasonInput, setReasonInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchWithAuth(`/api/organizations/${orgId}/external-publish-pause`);
    if (!res.ok) return;
    const json = (await res.json().catch(() => null)) as { data?: PauseState } | null;
    if (json?.data) setState(json.data);
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (nextPaused: boolean) => {
    setSubmitting(true);
    setError(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/external-publish-pause`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: nextPaused, reason: nextPaused ? (reasonInput || null) : null }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: PauseState } | null;
        if (json?.data) setState(json.data);
        setReasonInput('');
      } else {
        setError(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (state === null) return null;

  return (
    <Card className="p-4 space-y-3" data-testid="external-publish-pause-card">
      {state.paused ? (
        <Alert variant="destructive" role="alert" aria-live="polite" aria-atomic="true" data-testid="external-publish-pause-banner">
          <AlertDescription>
            {state.reason
              ? t('externalPublishPausedWithReason', { reason: state.reason })
              : t('externalPublishPaused')}
          </AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="external-publish-pause-status-active">
          {t('externalPublishActive')}
        </p>
      )}
      {isOwnerStrict ? (
        state.paused ? (
          <Button
            variant="outline" size="sm" disabled={submitting}
            data-testid="external-publish-resume-action"
            onClick={() => handleToggle(false)}
          >
            {t('externalPublishResumeAction')}
          </Button>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              placeholder={t('externalPublishPauseReasonPlaceholder')}
              value={reasonInput}
              onChange={(e) => setReasonInput(e.target.value)}
              data-testid="external-publish-pause-reason-input"
            />
            <Button
              variant="destructive" size="sm" disabled={submitting}
              data-testid="external-publish-pause-action"
              onClick={() => handleToggle(true)}
            >
              {t('externalPublishPauseAction')}
            </Button>
          </div>
        )
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="external-publish-pause-error">
          {t('externalPublishPauseActionFailed')}
        </p>
      ) : null}
    </Card>
  );
}
