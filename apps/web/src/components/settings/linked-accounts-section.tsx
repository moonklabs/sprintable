'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
// 동작) — SetPasswordSection과 같은 하드코딩 영문 톤(이 컴포넌트군은 next-intl 미배선)을
// 그대로 따른다.
export function LinkedAccountsSection() {
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
      setMessage({ type: 'success', text: `${linked === 'apple' ? 'Apple' : 'Google'} account connected.` });
      void refresh();
    } else if (linkError) {
      // story #3122 AC2 — PROVIDER_ALREADY_LINKED는 "이미 연결됨"이 아니라 "다른 계정에
      // 묶여있어 거부됨"이라 문구를 갈라야 사용자가 오해하지 않는다(병합이 아니라는 것).
      const text = linkError === 'PROVIDER_ALREADY_LINKED'
        ? 'That account is already linked to a different Sprintable account.'
        : linkError === 'LINK_SESSION_MISMATCH'
          ? 'Your session changed during linking. Please try again.'
          : linkError === 'SESSION_EXPIRED'
            ? 'Your session expired before linking finished. Please try again.'
            : 'Failed to connect account.';
      setMessage({ type: 'error', text });
    }
  }, [searchParams]);

  const handleUnlink = async (provider: ProviderId) => {
    setUnlinking(provider);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/oauth/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const json = await res.json() as { error?: { code?: string } };
      if (!res.ok) {
        const text = json.error?.code === 'LAST_LOGIN_METHOD'
          ? 'This is your only sign-in method — set a password or connect another account before disconnecting.'
          : 'Failed to disconnect account.';
        setMessage({ type: 'error', text });
        return;
      }
      setMessage({ type: 'success', text: `${provider === 'apple' ? 'Apple' : 'Google'} account disconnected.` });
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
          <h2 className="text-base font-semibold text-foreground">Connected Accounts</h2>
          <p className="text-sm text-muted-foreground">
            Connect another sign-in method to this account, or disconnect one you no longer use.
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <p
            role={message.type === 'success' ? 'status' : 'alert'}
            aria-live={message.type === 'success' ? 'polite' : 'assertive'}
            aria-atomic="true"
            className={`text-sm ${message.type === 'success' ? 'text-success' : 'text-destructive'}`}
          >
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
                  <p className="text-xs text-muted-foreground">{connected ? 'Connected' : 'Not connected'}</p>
                </div>
                {connected ? (
                  <button
                    onClick={() => void handleUnlink(id)}
                    disabled={!canUnlink || unlinking === id}
                    title={canUnlink ? undefined : 'This is your only sign-in method'}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50 disabled:opacity-50"
                  >
                    {unlinking === id ? '...' : 'Disconnect'}
                  </button>
                ) : (
                  <a
                    href={`/auth/link?provider=${id}`}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/50"
                  >
                    Connect
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
