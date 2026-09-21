'use client';

import { useState } from 'react';
import type { useTranslations } from 'next-intl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #4116(#4112 유나 시안 55a04e8d §3) — 연산 커넥터 등록 인라인 폼. provider는
 * 현재 vertex_gemini 1종 고정 표시(선택 불가). 모달리티별 모델 id(이미지·영상·음성)를
 * `model_config_json`으로 조립한다 — 빈 칸은 아예 키를 안 실어(#4110 BE는 이 필드의
 * shape를 강제 안 하지만, "비워 두면 그 모달리티는 이 커넥터로 생성하지 않아요"라는
 * 문구 계약을 지키려면 빈 문자열이 아니라 키 자체가 없어야 한다).
 *
 * pasted-secret-connect-card.tsx의 §2 규율(autoComplete off·제출/오류 무관 자격 칸
 * 비움)을 credentials 필드에 그대로 적용 — 이 폼은 채널 커넥터와 달리 필드가 채널마다
 * 갈리는 표 기반이 아니라(provider 1종 고정) 전용 컴포넌트로 짠다.
 */
export function GenerationConnectorRegisterForm({
  orgId, onRegistered, onCancel, t, tc, tChannel,
}: {
  orgId: string;
  onRegistered: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
  tc: ReturnType<typeof useTranslations>;
  // story #4116 — channelConnect ns의 기존 channelConnectPastedSecretRewriteNote 재사용
  // (마케팅 v2 다이얼로그의 tChannel 패턴과 동형, 신규 마스킹 문구 발명 0).
  tChannel: ReturnType<typeof useTranslations>;
}) {
  const [label, setLabel] = useState('');
  const [modelImage, setModelImage] = useState('');
  const [modelVideo, setModelVideo] = useState('');
  const [modelVoice, setModelVoice] = useState('');
  const [credentials, setCredentials] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = label.trim().length > 0 && label.trim().length <= 200 && credentials.trim().length > 0;

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    const modelConfigJson: Record<string, string> = {};
    if (modelImage.trim()) modelConfigJson.image = modelImage.trim();
    if (modelVideo.trim()) modelConfigJson.video = modelVideo.trim();
    if (modelVoice.trim()) modelConfigJson.voice = modelVoice.trim();
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/generation-connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_key: 'vertex_gemini',
          label: label.trim(),
          model_config_json: modelConfigJson,
          credentials: credentials.trim(),
        }),
      });
      // story #4116 §2 "다시 못 봄" — 성공/실패 무관하게 자격 칸은 이 시점에 비운다
      // (pasted-secret-connect-card.tsx 관례 그대로, 재입력=덮어쓰기).
      setCredentials('');
      if (res.ok) {
        onRegistered();
        return;
      }
      // story #4116 실측(그라운딩) — provider 미지원은 422로 깔끔히 분기되지만(라우터가
      // 명시 try/except), 이름 중복(UNIQUE 제약)은 서비스 계층이 IntegrityError를 안
      // 잡아 main.py::unhandled_exception_handler의 제네릭 500(code=INTERNAL_ERROR)으로
      // 떨어진다 — «중복 이름» 케이스를 구조적으로 구분할 신호가 응답에 없다(디버그
      // 모드가 아니면 message도 "Internal server error" 고정, str(exc) 매칭은 fragile해서
      // 안 한다). gcErrorLabelDuplicate 문구(#4112 표)는 정본이지만 지금은 못 틔운다 —
      // BE가 IntegrityError→409 처리를 추가해야 트리거 가능(PO에 발견 보고, 이 카드
      // 범위 밖 — BE/BFF 무변 경계).
      if (res.status === 422) {
        setError(t('gcErrorProviderUnsupported'));
      } else {
        setError(t('gcErrorGeneric'));
      }
    } catch {
      setCredentials('');
      setError(t('gcErrorGeneric'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-3 p-4" data-testid="gc-register-form">
      {error ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('gcFieldProvider')}</label>
        <div className="flex items-center justify-between rounded-md border border-input bg-muted px-3 py-1.5 text-sm text-muted-foreground">
          <span>{t('gcProviderVertexGeminiLabel')} <span className="ml-1 rounded border border-input bg-background px-1 py-0.5 font-mono text-[10px]">vertex_gemini</span></span>
          <span className="text-[11px] text-muted-foreground">{t('gcFieldProviderCurrentNote')}</span>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="gc-field-label">{t('gcFieldLabel')}</label>
        <input
          id="gc-field-label"
          type="text"
          className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t('gcFieldLabelPlaceholder')}
          autoComplete="off"
        />
        <p className="text-[10.5px] text-muted-foreground">{t('gcLabelHint')}</p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">{t('gcFieldModelIds')}</label>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('gcFieldModelImage')}</p>
            <input
              id="gc-field-model-image"
              type="text"
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
              value={modelImage}
              onChange={(e) => setModelImage(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('gcFieldModelVideo')}</p>
            <input
              id="gc-field-model-video"
              type="text"
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
              value={modelVideo}
              onChange={(e) => setModelVideo(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <p className="mb-1 text-[10px] text-muted-foreground">{t('gcFieldModelVoice')}</p>
            <input
              id="gc-field-model-voice"
              type="text"
              className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs"
              value={modelVoice}
              onChange={(e) => setModelVoice(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <p className="text-[10.5px] text-muted-foreground">{t('gcModelHint')}</p>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="gc-field-credential">{t('gcFieldCredential')}</label>
        <textarea
          id="gc-field-credential"
          className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs"
          value={credentials}
          onChange={(e) => setCredentials(e.target.value)}
          placeholder={t('gcCredentialPlaceholder')}
          autoComplete="off"
        />
        {/* 기존 channelConnect 마스킹 노트 재사용(디자인 지시·신규 발명 0). */}
        <p className="text-[11px] text-warning-strong" data-testid="gc-credential-mask-note">
          {tChannel('channelConnectPastedSecretRewriteNote')}
        </p>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>{tc('cancel')}</Button>
        <Button
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={saving || !canSubmit}
          data-testid="gc-register-submit"
        >
          {tc('save')}
        </Button>
      </div>
    </Card>
  );
}
