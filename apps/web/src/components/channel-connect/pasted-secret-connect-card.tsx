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

// story #3813 PR5-a CHANGES(페드루 PO 確定 2026-09-12) — export: verify-pasted-
// secret-bff-route-registered.ts가 이 표를 유일한 채널 목록 출처로 삼는다(중복
// 선언 0 — 새 채널이 여기 늘면 그 가드가 자동으로 대상에 포함한다).
export const PASTED_SECRET_FIELDS: Record<string, PastedSecretField[]> = {
  wordpress: [
    { name: 'site_url', labelKey: 'channelConnectFieldSiteUrl', type: 'text' },
    { name: 'username', labelKey: 'channelConnectFieldUsername', type: 'text' },
    { name: 'app_password', labelKey: 'channelConnectFieldAppPassword', type: 'password' },
  ],
  webhook: [
    { name: 'target_url', labelKey: 'channelConnectFieldTargetUrl', type: 'text' },
    { name: 'secret', labelKey: 'channelConnectFieldSecret', type: 'password' },
  ],
  // story #3813(Phase3·3-4 PR5-a, 페드루 PO 確定 2026-09-12) — 실 stibee 연결 폼
  // 그라운딩 결함 처방(이 표에 항목 자체가 없어 「Connect Stibee」를 눌러도 빈
  // 패널만 펼쳐지던 결함). 주소록 ID는 세그먼트 열거 API가 Enterprise 요금제
  // 전용이라 사람이 스티비 화면에서 직접 읽어 입력하는 값(카드 원문 "사람이 입력
  // 하는 「주소록 ID」 필드").
  // story #3813(Phase3·3-4 PR5-b, 페드루 PO 確定 2026-09-12) — 발신자 이메일·
  // 이름 2필드 추가(실 발행 `POST /emails`가 요구, 그라운딩 확認). senderEmail은
  // 스티비 발신자 인증 화면에서 이미 인증한 주소여야 발행이 통과한다 — 여기선
  // 형식만 검사, 인증 여부는 발행 시점에야 확認된다(연결 저장 단계에서 auth-check
  // 처럼 실호출 왕복하지 않는다).
  stibee: [
    { name: 'api_key', labelKey: 'channelConnectFieldApiKey', type: 'password' },
    { name: 'list_id', labelKey: 'channelConnectFieldListId', type: 'text' },
    { name: 'sender_email', labelKey: 'channelConnectFieldSenderEmail', type: 'text' },
    { name: 'sender_name', labelKey: 'channelConnectFieldSenderName', type: 'text' },
  ],
  // story #3816(Phase3·3-6 PR1, 페드루 PO 確定 2026-09-12) — Ghost Admin API 키
  // 연결 폼. site_url은 wordpress 필드 라벨을 그대로 재사용(같은 뜻 — 목적지 사이트
  // 주소, 채널마다 새 라벨을 만들지 않는다).
  ghost: [
    { name: 'site_url', labelKey: 'channelConnectFieldSiteUrl', type: 'text' },
    { name: 'admin_api_key', labelKey: 'channelConnectFieldAdminApiKey', type: 'password' },
  ],
};

// 유나 판정(PO 전언 2026-09-04 23:20Z) — "어디서 오나"는 채널마다 다른 문구라 표로 뺀다
// (필드 값 constraints와 같은 원칙, 하드코딩 회피).
const PASTED_SECRET_HINT_KEY: Record<string, string> = {
  wordpress: 'channelConnectPastedSecretHintWordpress',
  webhook: 'channelConnectPastedSecretHintWebhook',
  stibee: 'channelConnectPastedSecretHintStibee',
  ghost: 'channelConnectPastedSecretHintGhost',
};

// story #3816(Phase3·3-6 PR1, 유나 §낱말 한 벌·PO 정정 1, 2026-09-12) — 요금제
// 도움 문구는 "어디서 오나" 힌트와 다른 자리(별개 개념 — 채널 성질이지 자격 출처가
// 아니다)다. 다른 채널엔 이 축 자체가 없어 표에 항목이 없으면 그냥 안 그린다.
// PO 明示 — "확인 못했다"류 0(제품이 플랜을 확인하려 든 적 없다), 상태 낱말 신설 0.
const PASTED_SECRET_PLAN_NOTE_KEY: Record<string, string> = {
  ghost: 'channelConnectPastedSecretPlanNoteGhost',
};

// story #3816 CHANGES 3(유나 판정 issuecomment-5645662831·PO 確定 2026-09-12) —
// 오류 뒤 blanket 리셋(전 필드 비움) 폐기 발견: 주소 오류 배너("사이트 주소를
// 확인해 주세요")인데 그 칸 자체가 지워져 있는 두 세계였다(유나 재실측 —
// stibee "주소록 ID"도 같은 클래스). 새 불변식: 오류 응답 뒤 비-시크릿 입력은
// 유지·시크릿(type=password)만 비움 + 오류가 지목하는 필드로 포커스.
//
// 「키 오류」류(재발급/재확認하면 풀림 — 이미 채운 값이 틀렸다는 뜻이라 비우고
// 다시 입력받는 게 맞다)만 명시 등재한다(지어내지 않는다 — 모르는 코드는 포커스
// 이동 자체를 안 한다). wordpress/webhook은 아직 저장 시 실호출 검증이 없어
// 이 축의 코드 자체가 없다.
const KEY_INVALID_ERROR_CODES = new Set(['GHOST_ADMIN_KEY_INVALID', 'STIBEE_API_KEY_INVALID']);

// 「주소/목적지 오류」류 — 코드마다 지목하는 필드가 달라 명시 표로 둔다(생성 규칙이
// 없다, 채널별 실제 계약 그대로).
const ERROR_CODE_FOCUS_FIELD: Record<string, string> = {
  GHOST_SITE_NOT_FOUND: 'site_url',
};

export function focusFieldNameForError(
  code: string | undefined, fields: PastedSecretField[], values: Record<string, string>,
): string | null {
  if (!code) return null;
  // *_FIELDS_REQUIRED(채널마다 접두만 다르고 접미는 공용, 4채널 전부 동형) — 아직
  // 안 채운 첫 필드로(어느 칸이 비었는지 사람이 스스로 찾게 만들지 않는다).
  if (code.endsWith('FIELDS_REQUIRED')) {
    const firstEmpty = fields.find((f) => !(values[f.name] ?? '').trim());
    return firstEmpty?.name ?? null;
  }
  if (KEY_INVALID_ERROR_CODES.has(code)) {
    return fields.find((f) => f.type === 'password')?.name ?? null;
  }
  return ERROR_CODE_FOCUS_FIELD[code] ?? null;
}

// story #3816 CHANGES 3 — 시크릿(type=password) 필드만 비운 새 값을 만든다(비-
// 시크릿은 그대로 보존). 성공 시(§2 "다시 못 봄")는 이 함수를 안 쓰고 여전히
// 전부 비운다 — 실패 응답 전용 규칙.
function clearSecretFieldsOnly(
  values: Record<string, string>, fields: PastedSecretField[],
): Record<string, string> {
  const next = { ...values };
  for (const f of fields) {
    if (f.type === 'password') next[f.name] = '';
  }
  return next;
}

export function PastedSecretConnectCard({
  channel, orgId, isOwner, connectionCount, onConnected, t,
}: {
  channel: string;
  orgId: string;
  isOwner: boolean;
  // story #3436 묶음10(유나 §17-21⑧, PO 確定 2026-09-06) — 이 채널의 기존 연결 수.
  // 0개면 "연결"(그대로), 1개 이상이면 "연결 추가"로 버튼 낱말이 갈린다(wordpress·
  // webhook은 둘째 연결이 유의미 — sandbox #3537과 달리 버튼 자체를 숨기지 않는다).
  connectionCount: number;
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
  // 버튼은 탭 순서 밖이라 스크린리더가 사유에 못 닿는다). story #3504 — 이 폼은
  // owner|admin 폭(create_pasted_secret_channel_connection = _require_owner_or_admin)
  // 이라 owner 전용 문구(channelOwnerOnlyReason)는 거짓이다 — 두 폭 전용 키로.
  // story #3436 묶음10(유나 §17-21⑨, PO 確定) — 그 "두 폭 전용 키" 원칙을 이 버튼
  // 자리에도 한 번 더 적용한다: 공용 channelOwnerOrAdminOnlyReason(다른 자리와도
  // 공유)이 아니라 이 연결 버튼 전용 channelConnectOwnerOrAdminOnlyReason으로 —
  // 공용 키를 바꾸면 다른 자리 문구가 조용히 좁아진다.
  if (!isOwner) {
    return <p className="text-xs text-muted-foreground">{t('channelConnectOwnerOrAdminOnlyReason', { channel: channelLabel(channel, t) })}</p>;
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
      if (res.ok) {
        // §2 "다시 못 봄" — 성공 시엔 전부 비운다(회귀 0, 기존 관례 그대로).
        setValues({});
        setEditing(false);
        onConnected();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      setError(t(code ? connectErrorLabelKey(code, isOwner) : 'channelConnectErrorGeneric'));
      // story #3816 CHANGES 3 — blanket 리셋 폐기(유나 판정). 시크릿만 비우고
      // 비-시크릿 입력은 유지 + 오류가 지목하는 필드로 포커스.
      setValues((v) => clearSecretFieldsOnly(v, fields));
      const focusField = focusFieldNameForError(code, fields, values);
      if (focusField) {
        document.getElementById(`${channel}-${focusField}`)?.focus();
      }
    } catch {
      setValues((v) => clearSecretFieldsOnly(v, fields));
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
          {t(connectionCount === 0 ? 'channelConnectPastedSecretAction' : 'channelConnectPastedSecretAnotherAction', { channel: channelLabel(channel, t) })}
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
          {PASTED_SECRET_PLAN_NOTE_KEY[channel] ? (
            <p className="text-xs text-muted-foreground" data-testid={`channel-connect-pasted-secret-plan-note-${channel}`}>
              {t(PASTED_SECRET_PLAN_NOTE_KEY[channel]!)}
            </p>
          ) : null}
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
