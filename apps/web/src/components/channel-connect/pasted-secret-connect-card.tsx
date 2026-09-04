'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { connectErrorLabelKey } from '@/components/channel-connect/connect-error';

/**
 * story #3450 FE 후속(3653a18c §2 "②발급해서 붙여넣기" 방식, 페드루 PO 確定
 * 2026-09-04 23:13Z) — WordPress·webhook 연결 카드. BFF #3820(`POST .../channel-
 * connections/{wordpress|webhook}`, BE `CreatePastedSecretConnectionRequest`
 * 그대로)로 붙여넣기 폼을 잇는다. 필드는 채널마다 다르므로 하드코딩하지 않고
 * 표로 뺀다(담롱군 §4-6 재발 방지 원칙과 동형 — 채널이 늘어도 이 표만 는다).
 *
 * §2 "한 번 지나간다(저장 뒤 마스킹, 다시 못 봄)" — secret류 필드는 성공·실패
 * 무관하게 제출 직후 폼에서 비운다(app-credentials-card.tsx와 동일 원칙).
 * §2 "재입력은 덮어쓰기" — 부분 수정 UI가 없다, 취소하면 전부 비워지고 처음부터.
 *
 * 유나 판정(PO 전언 2026-09-04 23:20Z, 카드 형태) — ①레이아웃=카드 안 인라인
 * 펼침(다이얼로그 아님, oauth·sandbox 버튼과 같은 자리) ②문구=「WordPress 연결」·
 * 「웹훅 연결」(oauth 「Threads 계정 연결」과 같은 낱말 축 — "만들기"는 진짜로 짓는
 * sandbox 전용, 여기 안 씀) ③도움말 두 줄·다른 자리(필드 위=어디서 오나, 필드
 * 아래=재입력 원칙) ④owner 전용(비owner는 폼 자체 비노출) ⑤재방문 화면에 secret
 * 끝 4자리조차 없음(BFF 응답 스키마에 그 필드가 아예 없다 — types.ts 참고).
 */
interface PastedSecretField {
  name: string;
  labelKey: string;
  type: 'text' | 'password';
}

const PASTED_SECRET_FIELDS: Record<string, PastedSecretField[]> = {
  wordpress: [
    { name: 'site_url', labelKey: 'channelConnectFieldSiteUrl', type: 'text' },
    { name: 'username', labelKey: 'channelConnectFieldUsername', type: 'text' },
    { name: 'app_password', labelKey: 'channelConnectFieldAppPassword', type: 'password' },
  ],
  webhook: [
    { name: 'target_url', labelKey: 'channelConnectFieldTargetUrl', type: 'text' },
    { name: 'secret', labelKey: 'channelConnectFieldSecret', type: 'password' },
  ],
};

// 유나 판정(PO 전언 2026-09-04 23:20Z) — "어디서 오나"는 채널마다 다른 문구라 표로 뺀다
// (필드 값 constraints와 같은 원칙, 하드코딩 회피).
const PASTED_SECRET_HINT_KEY: Record<string, string> = {
  wordpress: 'channelConnectPastedSecretHintWordpress',
  webhook: 'channelConnectPastedSecretHintWebhook',
};

export function PastedSecretConnectCard({
  channel, orgId, isOwner, onConnected, t,
}: {
  channel: string;
  orgId: string;
  isOwner: boolean;
  onConnected: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const fields = PASTED_SECRET_FIELDS[channel];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!fields) return null;

  // §5 정본(2026-09-04) — 비소유자는 버튼 자체를 안 그리고 사유 한 줄만(disabled
  // 버튼은 탭 순서 밖이라 스크린리더가 사유에 못 닿는다).
  if (!isOwner) {
    return <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p>;
  }

  const allFilled = fields.every((f) => (values[f.name] ?? '').trim().length > 0);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${channel}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      // §2 "다시 못 봄" — 성공/실패 무관하게 여기서 비운다(app-credentials-card.tsx와
      // 동일 이유 — 로그·상태에 secret을 남기지 않는다).
      setValues({});
      if (res.ok) {
        setEditing(false);
        onConnected();
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
        <Button
          size="sm"
          onClick={() => setEditing(true)}
          data-testid={`channel-connect-pasted-secret-button-${channel}`}
        >
          {t('channelConnectPastedSecretAction', { channel: channelLabel(channel, t) })}
        </Button>
      ) : (
        <div className="w-full space-y-2" data-testid={`channel-connect-pasted-secret-form-${channel}`}>
          {error ? (
            <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {/* 유나 판정 §③ — 도움말 두 줄·다른 자리. 필드 위=어디서 오나(채널별). */}
          <p className="text-xs text-muted-foreground" data-testid={`channel-connect-pasted-secret-hint-${channel}`}>
            {t(PASTED_SECRET_HINT_KEY[channel])}
          </p>
          {fields.map((f) => (
            <div key={f.name} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`${channel}-${f.name}`}>
                {t(f.labelKey)}
              </label>
              <input
                id={`${channel}-${f.name}`}
                type={f.type}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={values[f.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                autoComplete="off"
              />
            </div>
          ))}
          {/* 필드 아래=재입력 원칙(§2 "다시 못 봄"·"재입력은 덮어쓰기" 그대로 사람 말로). */}
          <p className="text-xs text-muted-foreground" data-testid={`channel-connect-pasted-secret-rewrite-note-${channel}`}>
            {t('channelConnectPastedSecretRewriteNote')}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleSubmit()}
              disabled={saving || !allFilled}
              data-testid={`channel-connect-pasted-secret-submit-${channel}`}
            >
              {saving ? t('channelConnectPastedSecretPendingCta') : t('channelConnectPastedSecretSubmitAction')}
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
