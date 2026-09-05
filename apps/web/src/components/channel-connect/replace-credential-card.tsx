'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { connectErrorLabelKey } from '@/components/channel-connect/connect-error';

/**
 * story #3492(Phase1·마케팅운영·소형, 페드루 PO 決定 2026-09-05) — 붙여넣기(pasted_
 * secret) 연결 「자격 제자리 교체」. pasted-secret-connect-card.tsx(생성 폼)와 §2 동형
 * 원칙 그대로 — secret류 필드는 제출 직후 무조건 비우고(§2 "다시 못 봄"), 재입력은
 * 덮어쓰기다. 다른 점은 site_url/target_url 등 목적지 필드가 없다(id·계정 축은
 * 불변 — 이 폼은 자격만 바꾼다) 뿐.
 *
 * §2 규격 3 — 재방문 시 원문은 절대 안 보이고 끝 4자리(secret_hint)만 표시한다.
 */
interface ReplaceField {
  name: string;
  labelKey: string;
  type: 'text' | 'password';
  required: boolean;
}

const REPLACE_FIELDS: Record<string, ReplaceField[]> = {
  wordpress: [
    { name: 'username', labelKey: 'channelConnectFieldUsername', type: 'text', required: false },
    { name: 'app_password', labelKey: 'channelConnectFieldAppPassword', type: 'password', required: true },
  ],
  webhook: [
    { name: 'secret', labelKey: 'channelConnectFieldSecret', type: 'password', required: true },
  ],
};

export function ReplaceCredentialCard({
  channel, connectionId, secretHint, isOwner, orgId, onReplaced, t,
}: {
  channel: string;
  connectionId: string;
  secretHint: string | null;
  isOwner: boolean;
  orgId: string;
  onReplaced: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const fields = REPLACE_FIELDS[channel];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!fields) return null;

  // §5 정본과 동형 — 비owner/admin은 버튼 자체를 안 그리고 사유 한 줄만.
  if (!isOwner) {
    return <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p>;
  }

  const allFilled = fields.every((f) => !f.required || (values[f.name] ?? '').trim().length > 0);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${connectionId}/credentials`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      // §2 "다시 못 봄" — 성공/실패 무관하게 여기서 비운다.
      setValues({});
      if (res.ok) {
        setEditing(false);
        onReplaced();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        const code = body?.error?.code;
        setError(t(code ? connectErrorLabelKey(code, isOwner) : 'channelConnectErrorGeneric'));
      }
    } catch {
      setValues({});
      setError(t('channelConnectErrorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-start gap-2">
      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          {secretHint ? (
            <span className="text-xs text-muted-foreground" data-testid={`channel-connect-secret-hint-${connectionId}`}>
              {t('channelConnectSecretHintLabel', { hint: secretHint })}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
            data-testid={`channel-connect-replace-credential-button-${connectionId}`}
          >
            {t('channelConnectReplaceCredentialAction')}
          </Button>
        </div>
      ) : (
        <div className="w-full space-y-2" data-testid={`channel-connect-replace-credential-form-${connectionId}`}>
          {error ? (
            <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`${connectionId}-${f.name}`}>
                {t(f.labelKey)}
              </label>
              <input
                id={`${connectionId}-${f.name}`}
                type={f.type}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                autoComplete="off"
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground" data-testid={`channel-connect-replace-credential-rewrite-note-${connectionId}`}>
            {t('channelConnectPastedSecretRewriteNote')}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={saving || !allFilled}
              data-testid={`channel-connect-replace-credential-submit-${connectionId}`}
            >
              {saving ? t('channelConnectReplaceCredentialPendingCta') : t('channelConnectReplaceCredentialSubmitAction')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setEditing(false); setValues({}); setError(null); }}
            >
              {t('appCredentialsCancelAction')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
