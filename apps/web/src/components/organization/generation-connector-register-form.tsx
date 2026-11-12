'use client';

import { useState } from 'react';
import type { useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { Field } from '@/components/ds/field';
import { Input, Textarea } from '@/components/ds/input';
import { NativeSelect } from '@/components/ds/select';
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
 *
 * story #4140(페드루 PO 처방, 2026-09-22) — 리전(location) select 추가. 2호 실사고
 * (aa1c2330·gemini-2.5-flash-image가 asia-northeast3에서 404 → 댄군 자체 판단으로
 * global 재시도)의 직접 처방 — "어느 리전을 쓸지"가 제품 밖(에이전트 재량)에 있던 것을
 * 제품 값으로 가져온다. 허용 목록·기본값은 BE와 동일 폭(`GENERATION_CONNECTOR_LOCATIONS`
 * — 추측 0 원칙으로 이 세션에서 실제 확認된 2개뿐, org_generation_connector.py 모델
 * 주석 참조). 힌트 문구는 가용성을 단정하지 않는다(PO 처방 원문 그대로 — "모델별 가용
 * 리전은 Vertex 문서 기준이에요 — global이 가장 넓어요").
 *
 * story #4166 — 아래 두 상수를 export한다. «리전 변경» 행 액션(page.tsx)이 이
 * 허용 목록·기본값을 재사용한다(새 목록을 또 만들지 않는다 — BE
 * GENERATION_CONNECTOR_LOCATIONS와 동일 폭, 추측 0).
 */
export const GENERATION_CONNECTOR_LOCATIONS = ['global', 'asia-northeast3'] as const;
export const DEFAULT_GENERATION_CONNECTOR_LOCATION: (typeof GENERATION_CONNECTOR_LOCATIONS)[number] = 'global';

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
  const [location, setLocation] = useState<string>(DEFAULT_GENERATION_CONNECTOR_LOCATION);
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
    const modelConfigJson: Record<string, string> = { location };
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
      // story #4117 FE 라이더 — #4117-BE(PR #4492)가 이름 중복(UNIQUE 제약)의
      // IntegrityError를 잡아 409 {"code": "GENERATION_CONNECTOR_LABEL_DUPLICATE"}로
      // 바꿨다(라우트가 non-2xx는 그대로 pass-through하므로 FastAPI HTTPException
      // 관례대로 {"detail": {"code": ...}} 꼴로 온다). 이 신호가 있을 때만
      // gcErrorLabelDuplicate로 분기 — 다른 409(있다면)나 파싱 실패는 제네릭으로
      // 안전하게 폴백(신호 없이 지어내지 않는다).
      if (res.status === 422) {
        setError(t('gcErrorProviderUnsupported'));
      } else if (res.status === 409) {
        let code: string | undefined;
        try {
          const body = await res.json() as { detail?: { code?: string } };
          code = body.detail?.code;
        } catch {
          code = undefined;
        }
        setError(code === 'GENERATION_CONNECTOR_LABEL_DUPLICATE' ? t('gcErrorLabelDuplicate') : t('gcErrorGeneric'));
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
    <Card className="flex flex-col gap-4 p-4" data-testid="gc-register-form">
      {error ? <Banner tone="failed">{error}</Banner> : null}

      {/* provider는 지금 1종 고정 — 고를 수 없는 값은 칸이 아니라 읽기 전용 줄(4913 틀: 칸처럼 보이는 가짜 입력 0). */}
      <div className="flex flex-col gap-1">
        <span className="text-ds-small font-semibold text-ds-ink">{t('gcFieldProvider')}</span>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-ds-control border border-ds-line bg-ds-surface-high px-3 py-2 text-ds-body text-ds-ink-2">
          <span className="flex items-center gap-2">{t('gcProviderVertexGeminiLabel')} <Chip>vertex_gemini</Chip></span>
          <span className="text-ds-small text-ds-ink-3">{t('gcFieldProviderCurrentNote')}</span>
        </div>
      </div>

      <Field label={t('gcFieldLocation')} hint={t('gcLocationHint')}>
        {(c) => (
          <NativeSelect {...c} value={location} onChange={(e) => setLocation(e.target.value)} data-testid="gc-field-location">
            {GENERATION_CONNECTOR_LOCATIONS.map((loc) => (
              <option key={loc} value={loc}>{loc}</option>
            ))}
          </NativeSelect>
        )}
      </Field>

      <Field label={t('gcFieldLabel')} hint={t('gcLabelHint')}>
        {(c) => (
          <Input {...c} type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('gcFieldLabelPlaceholder')} autoComplete="off" />
        )}
      </Field>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-ds-small font-semibold text-ds-ink">{t('gcFieldModelIds')}</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label={t('gcFieldModelImage')}>
            {(c) => <Input {...c} type="text" className="font-mono" value={modelImage} onChange={(e) => setModelImage(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('gcFieldModelVideo')}>
            {(c) => <Input {...c} type="text" className="font-mono" value={modelVideo} onChange={(e) => setModelVideo(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label={t('gcFieldModelVoice')}>
            {(c) => <Input {...c} type="text" className="font-mono" value={modelVoice} onChange={(e) => setModelVoice(e.target.value)} autoComplete="off" />}
          </Field>
        </div>
        <p className="m-0 text-ds-small text-ds-ink-3">{t('gcModelHint')}</p>
      </fieldset>

      <Field label={t('gcFieldCredential')}>
        {(c) => (
          <Textarea {...c} className="min-h-20 font-mono" value={credentials} onChange={(e) => setCredentials(e.target.value)} placeholder={t('gcCredentialPlaceholder')} autoComplete="off" />
        )}
      </Field>
      {/* 기존 channelConnect 마스킹 노트 재사용(디자인 지시·신규 발명 0). */}
      <p className="m-0 text-ds-small text-ds-needs-hand" data-testid="gc-credential-mask-note">
        {tChannel('channelConnectPastedSecretRewriteNote')}
      </p>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>{tc('cancel')}</Button>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={saving || !canSubmit} data-testid="gc-register-submit">
          {tc('save')}
        </Button>
      </div>
    </Card>
  );
}
