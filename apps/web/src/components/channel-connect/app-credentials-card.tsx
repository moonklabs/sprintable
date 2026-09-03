'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import type { AppCredentialsPutResponse, AppCredentialsStatusResponse } from '@/components/channel-connect/types';

/**
 * story #3376 AC2(선생님 2026-09-03 08:28Z 정정·PO 08:40Z 보정·20:19 KST 계약 확定) —
 * 기본은 Sprintable 공용 앱(platform), 조직 앱 자격(org)은 옵션. `effective_source`
 * 하나로 세 상태를 가른다 — `configured`(=조직이 등록했나)와 섞지 않는다(별개 축).
 */
export function AppCredentialsCard({
  channel, orgId, isOwner, credentials, onSaved,
}: {
  channel: string;
  orgId: string;
  isOwner: boolean;
  credentials: AppCredentialsStatusResponse | undefined;
  onSaved: () => void;
}) {
  const t = useTranslations('channelConnect');
  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveSource = credentials?.effective_source ?? 'none';

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${channel}/app-credentials`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      // story #3376 QA 관점 — secret은 응답을 읽는 순간까지만 메모리에 있다가 버려진다.
      // 폼 입력값도 성공/실패 무관하게 여기서 비운다(로그·상태에 남기지 않는다).
      setAppId('');
      setAppSecret('');
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: AppCredentialsPutResponse } | null;
        if (json?.data) {
          setEditing(false);
          onSaved();
        }
      } else {
        setError(t('appCredentialsSaveFailed'));
      }
    } catch {
      setAppId('');
      setAppSecret('');
      setError(t('appCredentialsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <h2 className="text-sm font-semibold text-foreground">{t('appCredentialsTitle', { channel })}</h2>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        {effectiveSource === 'org' ? (
          <Alert variant="default" role="status">
            <AlertDescription>
              {t('appCredentialsOrgActive', { suffix: credentials?.app_id_suffix ?? '' })}
            </AlertDescription>
          </Alert>
        ) : effectiveSource === 'platform' ? (
          <Alert variant="default" role="status">
            <AlertDescription>{t('appCredentialsPlatformActive')}</AlertDescription>
          </Alert>
        ) : (
          // 유나 design verdict(f9cab0c23) — "설정 미완"은 「아직 안 한 것」이지 실패가
          // 아니다(같은 화면 not_connected 칩도 bg-muted 중립). org/platform과 같은 톤으로.
          <Alert variant="default" role="status">
            <AlertDescription>{t('appCredentialsNone')}</AlertDescription>
          </Alert>
        )}

        {!isOwner ? null : !editing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing(true)}
          >
            {effectiveSource === 'org' ? t('appCredentialsReenterAction') : t('appCredentialsRegisterAction')}
          </Button>
        ) : (
          <div className="space-y-2">
            {error ? (
              <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`app-id-${channel}`}>
                {t('appCredentialsAppIdLabel')}
              </label>
              <input
                id={`app-id-${channel}`}
                type="text"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor={`app-secret-${channel}`}>
                {t('appCredentialsAppSecretLabel')}
              </label>
              <input
                id={`app-secret-${channel}`}
                type="password"
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleSave()} disabled={saving || !appId || !appSecret}>
                {t('appCredentialsSaveAction')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setAppId(''); setAppSecret(''); setError(null); }}>
                {t('appCredentialsCancelAction')}
              </Button>
            </div>
          </div>
        )}
        {!isOwner ? <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p> : null}
      </SectionCardBody>
    </SectionCard>
  );
}
