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
 * 문구는 유나 §⑤ judgment(ec5d82b4-2106-4d29-83b2-afafbb7b393c, 착수 前 미리 판정)
 * 정본 그대로 — 낱말 정본(「멈춤 中」/「정상」)이 스위치·배너·감사 로그 사유
 * placeholder까지 한 벌로 일관된다. reason은 표시 0(입력만·감사 로그행에만 남음
 * — judgment가 "다시 보여줘라"를 요구하지 않는다).
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/external-publish-pause`);
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const json = (await res.json().catch(() => null)) as { data?: PauseState } | null;
      if (json?.data) {
        setState(json.data);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    } catch {
      setLoadFailed(true);
    }
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
        body: JSON.stringify({ paused: nextPaused, reason: reasonInput || null }),
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

  if (state === null) {
    if (!loadFailed) return null;
    return (
      <Card className="p-4 space-y-3" data-testid="external-publish-pause-card">
        <div>
          <p className="text-sm font-medium text-foreground">{t('externalPublishPauseCardTitle')}</p>
          <p className="text-xs text-destructive" data-testid="external-publish-pause-load-error">
            {t('externalPublishPauseLoadFailed')}
          </p>
        </div>
        <Button
          variant="outline" size="sm" disabled={retrying} aria-busy={retrying}
          data-testid="external-publish-pause-load-retry"
          onClick={async () => {
            setRetrying(true);
            try {
              await load();
            } finally {
              setRetrying(false);
            }
          }}
        >
          {t('externalPublishPauseLoadRetryCta')}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3" data-testid="external-publish-pause-card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-foreground">{t('externalPublishPauseCardTitle')}</p>
          {isOwnerStrict ? (
            <p className="text-xs text-muted-foreground">{t('externalPublishPauseCardOwnerDescription')}</p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('externalPublishAdminReadonlyNote')}</p>
          )}
        </div>
        <span
          className={
            state.paused
              ? 'rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/30 dark:text-amber-300'
              : 'rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground'
          }
          data-testid="external-publish-pause-status-pill"
        >
          {state.paused ? t('externalPublishStatusPaused') : t('externalPublishStatusActive')}
        </span>
      </div>

      {state.paused ? (
        <Alert variant="destructive" role="alert" aria-live="polite" aria-atomic="true" data-testid="external-publish-pause-banner">
          <AlertDescription>{t('externalPublishPaused')}</AlertDescription>
        </Alert>
      ) : null}

      {isOwnerStrict ? (
        <div className="space-y-2">
          <input
            type="text"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            placeholder={
              state.paused ? t('externalPublishResumeReasonPlaceholder') : t('externalPublishPauseReasonPlaceholder')
            }
            value={reasonInput}
            onChange={(e) => setReasonInput(e.target.value)}
            data-testid={state.paused ? 'external-publish-resume-reason-input' : 'external-publish-pause-reason-input'}
          />
          {state.paused ? (
            <Button
              variant="outline" size="sm" disabled={submitting}
              data-testid="external-publish-resume-action"
              onClick={() => handleToggle(false)}
            >
              {t('externalPublishResumeAction')}
            </Button>
          ) : (
            <Button
              variant="destructive" size="sm" disabled={submitting}
              data-testid="external-publish-pause-action"
              onClick={() => handleToggle(true)}
            >
              {t('externalPublishPauseAction')}
            </Button>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" data-testid="external-publish-pause-error">
          {t('externalPublishPauseActionFailed')}
        </p>
      ) : null}
    </Card>
  );
}
