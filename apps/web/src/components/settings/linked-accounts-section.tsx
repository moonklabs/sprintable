'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';

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
export function LinkedAccountsSection() {
  const t = useTranslations('settings');
  const searchParams = useSearchParams();
  const [linkedProviders, setLinkedProviders] = useState<ProviderId[] | null>(null);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [unlinking, setUnlinking] = useState<ProviderId | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const refresh = async () => {
    const res = await fetchWithAuth('/api/me');
    if (!res.ok) return;
    const json = await res.json() as { data?: { linked_providers?: ProviderId[]; has_password?: boolean } };
    setLinkedProviders(json.data?.linked_providers ?? []);
    setHasPassword(json.data?.has_password ?? null);
  };

  useEffect(() => {
    void refresh();
  }, []);

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
  }, [searchParams, t]);

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
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('linkedAccountsTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('linkedAccountsDescription')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          // 유나 design:changes(2026-08-26, PR#3532) — 라이트 테마 text-success on 배경이
          // 3.49:1로 AA(4.5) 미달 실측(StateHeader §654a74ba 선례 동형). 처방: 성공 텍스트는
          // text-foreground(중립, 양테마 AA 보장)로 두고 상태 신호는 그래픽(체크 아이콘,
          // 장식용 aria-hidden)으로만 준다 — "색은 그래픽·텍스트는 중립".
          <p
            role={message.type === 'success' ? 'status' : 'alert'}
            aria-live={message.type === 'success' ? 'polite' : 'assertive'}
            aria-atomic="true"
            className={`flex items-center gap-1.5 text-sm ${message.type === 'success' ? 'text-foreground' : 'text-destructive'}`}
          >
            {message.type === 'success' && <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />}
            {message.text}
          </p>
        )}

        <ul className="divide-y divide-border max-w-sm">
          {PROVIDERS.map(({ id, label }) => {
            const connected = linkedProviders.includes(id);
            const canUnlink = connected && loginMethodCount > 1;
            return (
              <li key={id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">{connected ? t('linkedAccountsConnected') : t('linkedAccountsNotConnected')}</p>
                </div>
                {connected ? (
                  <button
                    onClick={() => void handleUnlink(id)}
                    disabled={!canUnlink || unlinking === id}
                    title={canUnlink ? undefined : t('linkedAccountsOnlyMethodTitle')}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
                  >
                    {unlinking === id ? t('linkedAccountsDisconnecting') : t('linkedAccountsDisconnect')}
                  </button>
                ) : (
                  <a
                    href={`/auth/link?provider=${id}`}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50"
                  >
                    {t('linkedAccountsConnect')}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </SectionCardBody>
    </SectionCard>
  );
}
