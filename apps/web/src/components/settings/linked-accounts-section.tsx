'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { ListRow } from '@/components/ds/list-row';
import { SettingsSection } from './settings-section';
import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';

type ProviderId = 'google' | 'apple';

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'google', label: 'Google' },
  { id: 'apple', label: 'Apple' },
];

// story #3122(계정·후속) — #3118 그라운딩: Apple private relay 이메일이면 자동 이메일
// 병합이 원천 불가해 항상 신규 계정이 생긴다. PO 확定 정책: 병합은 사용자 주도 수동
// 연결로. has_password 유무로만 렌더 여부가 갈리는 SetPasswordSection과 달리 이 섹션은
// has_password와 무관하게 항상 보인다(로그인 방법이 뭐든 추가 provider 연결은 유효한
// 동작).
//
// story #3149(선생님 실사용 발견) — 원 구현이 SetPasswordSection과 같은 하드코딩 영문
// 톤을 그대로 따랐는데, 그 톤 자체가 선생님 실기기에서 "설정 화면 전체가 한국어인데
// 여기만 영문"으로 발견된 결함이었다(투자조사: 3rd-party 위젯 아님 — 이 레포 컴포넌트,
// i18n만 미배선). next-intl로 이관. Google/Apple은 브랜드 고유명사라 번역 대상 제외.
export interface LinkedAccountsSectionProps {
  // story #3772 — my-profile-section.tsx와 동형(탭 컨테이너에 초기 로드 실패 알림).
  onLoadError?: () => void;
}

export function LinkedAccountsSection({ onLoadError }: LinkedAccountsSectionProps = {}) {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();
  const [linkedProviders, setLinkedProviders] = useState<ProviderId[] | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [unlinking, setUnlinking] = useState<ProviderId | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // story #3772 CHANGES(카디르 QA b5ca5e384·07:36Z) — 이 함수는 초기 로드뿐 아니라
  // OAuth 연결 성공(:64)·연동 해제 성공(:98) 뒤 후속 refresh에도 재사용된다. 후속
  // refresh가 실패해도 onLoadError를 무조건 부르면 "연결됨" 성공 메시지 직후 부모
  // 탭의 「불러오지 못했습니다」 배너가 뜨는 오탐이 난다(codex vitest probe 재현) —
  // "onLoadError는 초기 로드 경로에서만"이 원 설계였는데 재사용 시 그 경계가 깨졌다.
  // isInitialLoad로 호출부가 경로를 명시한다(후속 refresh는 실패해도 기존 `message`
  // state로만 사용자에게 알리고, 부모 탭 배너는 건드리지 않는다).
  const refresh = useCallback(async (isInitialLoad = false) => {
    // story #3762 CHANGES(카디르 QA — /api/me reject 경로 테스트 中 발견, my-profile-
    // section.tsx와 동형 갭·페드루 PO 정정 — verify:no-fetch-response-without-ok-check
    // (#3688) 가드가 읽는 try/catch+res.ok 형으로) — 네트워크 자체가 죽으면(HTTP 에러
    // 응답이 아니라) fetchWithAuth가 reject해 이 아래 await가 그대로 throw,
    // `void refresh()`(:44) 밖으로 unhandled rejection이 샜다.
    let res: Response;
    try { res = await fetchMe(); } catch { if (isInitialLoad) onLoadError?.(); return; }
    if (!res.ok) { if (isInitialLoad) onLoadError?.(); return; }
    const json = await res.json() as { data?: { linked_providers?: ProviderId[]; has_password?: boolean } };
    setLinkedProviders(json.data?.linked_providers ?? []);
    setHasPassword(json.data?.has_password ?? null);
  }, [onLoadError]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const linked = searchParams.get('linked');
    const linkError = searchParams.get('link_error');
    if (linked) {
      const providerLabel = linked === 'apple' ? 'Apple' : 'Google';
      setMessage({ type: 'success', text: t('linkedAccountsLinkedSuccess', { provider: providerLabel }) });
      void refresh();
    } else if (linkError) {
      // story #3122 AC2 — PROVIDER_ALREADY_LINKED는 "이미 연결됨"이 아니라 "다른 계정에
      // 묶여있어 거부됨"이라 문구를 갈라야 사용자가 오해하지 않는다(병합이 아니라는 것).
      const text = linkError === 'PROVIDER_ALREADY_LINKED'
        ? t('linkedAccountsErrorAlreadyLinked')
        : linkError === 'LINK_SESSION_MISMATCH'
          ? t('linkedAccountsErrorSessionMismatch')
          : linkError === 'SESSION_EXPIRED'
            ? t('linkedAccountsErrorSessionExpired')
            : t('linkedAccountsErrorConnectFailed');
      setMessage({ type: 'error', text });
    }
  }, [searchParams, t, refresh]);

  const handleUnlink = async (provider: ProviderId) => {
    setUnlinking(provider);
    setMessage(null);
    try {
      const res = await fetchWithAuth('/api/auth/oauth/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const json = await res.json() as { error?: { code?: string } };
      if (!res.ok) {
        const text = json.error?.code === 'LAST_LOGIN_METHOD'
          ? t('linkedAccountsErrorLastLoginMethod')
          : t('linkedAccountsErrorDisconnectFailed');
        setMessage({ type: 'error', text });
        return;
      }
      const providerLabel = provider === 'apple' ? 'Apple' : 'Google';
      setMessage({ type: 'success', text: t('linkedAccountsUnlinkedSuccess', { provider: providerLabel }) });
      await refresh();
    } finally {
      setUnlinking(null);
    }
  };

  if (linkedProviders === null) return null;

  const loginMethodCount = (hasPassword ? 1 : 0) + linkedProviders.length;

  return (
    <SettingsSection title={t('linkedAccountsTitle')} description={t('linkedAccountsDescription')}>
      {message && (
        // 유나 design:changes(2026-08-26, PR#3532) — 성공 텍스트는 중립 색(양 테마 AA 보장)으로 두고 상태 신호는 그래픽(체크 아이콘, 장식용 aria-hidden)으로만 준다 — «색은 그래픽 · 텍스트는 중립».
        <p
          role={message.type === 'success' ? 'status' : 'alert'}
          aria-live={message.type === 'success' ? 'polite' : 'assertive'}
          aria-atomic="true"
          className={`flex items-center gap-1.5 text-ds-body ${message.type === 'success' ? 'text-ds-ink' : 'text-ds-failed'}`}
        >
          {message.type === 'success' && <Check className="size-3.5 shrink-0 text-ds-done" aria-hidden="true" />}
          {message.text}
        </p>
      )}

      {/* story 4891 (settings › profile ①): one ds ListRow per provider — the name + the state on the left, the one action (disconnect / connect) on the right; the same links and the same guard (the only login method cannot be disconnected) */}
      <ul className="max-w-sm divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line">
        {PROVIDERS.map(({ id, label }) => {
          const connected = linkedProviders.includes(id);
          const canUnlink = connected && loginMethodCount > 1;
          return (
            <li key={id}>
              <ListRow
                className="border-b-0"
                title={
                  <span className="block">
                    <span className="block text-ds-body font-semibold text-ds-ink">{label}</span>
                    <span className="block text-ds-small font-normal text-ds-ink-3">{connected ? t('linkedAccountsConnected') : t('linkedAccountsNotConnected')}</span>
                    {/* the REASON the disconnect is off is a visible line (not a hover title) and the button points at it (aria-describedby) */}
                    {connected && !canUnlink ? <span id={`linked-only-method-${id}`} className="mt-0.5 block whitespace-normal text-ds-small font-normal text-ds-ink-3">{t('linkedAccountsOnlyMethodTitle')}</span> : null}
                  </span>
                }
                trailing={
                  connected ? (
                    <Button
                      variant="secondary"
                      onClick={() => void handleUnlink(id)}
                      disabled={!canUnlink || unlinking === id}
                      // the name keeps the VISIBLE words (label-in-name): the idle name is «연결 해제 · provider», while it runs it follows the button's «해제 중…»
                      aria-label={unlinking === id ? `${t('linkedAccountsDisconnecting')} — ${label}` : t('linkedAccountsDisconnectAria', { provider: label })}
                      aria-describedby={canUnlink ? undefined : `linked-only-method-${id}`}
                    >
                      {unlinking === id ? t('linkedAccountsDisconnecting') : t('linkedAccountsDisconnect')}
                    </Button>
                  ) : (
                    <Button asChild variant="secondary" aria-label={t('linkedAccountsConnectAria', { provider: label })}>
                      <a href={`/auth/link?provider=${id}`}>{t('linkedAccountsConnect')}</a>
                    </Button>
                  )
                }
              />
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
