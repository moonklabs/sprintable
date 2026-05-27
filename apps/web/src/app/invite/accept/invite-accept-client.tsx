'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface InviteAcceptClientProps {
  token: string;
  orgName: string;
  role: string;
  email: string;
}

export function InviteAcceptClient({ token, orgName, role, email }: InviteAcceptClientProps) {
  const [accepting, setAccepting] = useState(false);
  const [result, setResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleAccept = async () => {
    if (accepting) return;
    setAccepting(true);
    try {
      const res = await fetch(`/api/invites/${token}/accept`, { method: 'POST' });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) {
        setResult({ type: 'error', text: json.error?.message ?? '초대 수락에 실패했습니다.' });
      } else {
        setResult({ type: 'success', text: '초대를 수락했습니다. Dashboard로 이동합니다.' });
        setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
      }
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="w-full max-w-sm rounded-2xl bg-background p-8 shadow-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-foreground">Organization 초대</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold text-foreground/85">{orgName}</span>에서 초대했습니다.
          </p>
          {email && <p className="text-xs text-muted-foreground/60">{email} 계정으로 가입됩니다.</p>}
        </div>

        <div className="rounded-lg border border-border bg-muted px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Organization</span>
            <span className="font-medium text-foreground/85">{orgName}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">역할</span>
            <span className="font-medium text-foreground/85 capitalize">{role}</span>
          </div>
        </div>

        {result ? (
          <div className={`rounded-lg p-3 text-sm text-center ${result.type === 'success' ? 'bg-success-bg text-success border border-success-border' : 'bg-destructive-bg text-destructive border border-destructive-border'}`}>
            {result.text}
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              className="w-full"
              onClick={() => void handleAccept()}
              disabled={accepting}
            >
              {accepting ? '수락 중…' : '초대 수락'}
            </Button>
            <a
              href="/dashboard"
              className="block text-center text-sm text-muted-foreground hover:text-foreground/70"
            >
              거절 (나중에)
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
