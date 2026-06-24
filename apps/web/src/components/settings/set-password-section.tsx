'use client';

import { useEffect, useState } from 'react';
import { Check, Circle } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

function checkPasswordRules(pw: string) {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    digit: /\d/.test(pw),
    special: /[^A-Za-z0-9]/.test(pw),
  };
}

function countCategories(rules: ReturnType<typeof checkPasswordRules>) {
  return [rules.upper, rules.lower, rules.digit, rules.special].filter(Boolean).length;
}

export function SetPasswordSection() {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/me');
      if (!res.ok) return;
      const json = await res.json() as { data?: { has_password?: boolean } };
      setHasPassword(json.data?.has_password ?? null);
    })();
  }, []);

  // has_password 필드 없거나 true면 렌더링하지 않는
  if (hasPassword !== false || done) return null;

  const rules = checkPasswordRules(password);
  const categoriesMet = countCategories(rules);
  const isPasswordValid = rules.length && categoriesMet >= 3;
  const isConfirmValid = confirm === password;
  const showRules = touched && password.length > 0;

  const handleSubmit = async () => {
    setTouched(true);
    if (!isPasswordValid || !isConfirmValid || !password) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: password }),
      });
      const json = await res.json() as { data?: { ok: boolean }; error?: { message: string } };
      if (!res.ok) {
        setMessage({ type: 'error', text: json.error?.message ?? 'Failed to set password.' });
        return;
      }
      setMessage({ type: 'success', text: 'Password set successfully. You can now sign in with email and password.' });
      setDone(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">Set Password</h2>
          <p className="text-sm text-muted-foreground">
            Your account was created with OAuth. Set a password to also sign in with email and password.
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message && (
          <p className={`text-sm ${message.type === 'success' ? 'text-success' : 'text-destructive'}`}>
            {message.text}
          </p>
        )}

        <div className="space-y-3 max-w-sm">
          <input
            type="password"
            placeholder="New password"
            autoComplete="new-password"
            className={`w-full rounded-lg border px-4 py-2 text-sm text-foreground bg-background focus:outline-none focus:ring-2 focus:ring-primary ${
              showRules && !isPasswordValid ? 'border-destructive' : 'border-border'
            }`}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setTouched(true); }}
            disabled={busy}
          />
          <input
            type="password"
            placeholder="Confirm new password"
            autoComplete="new-password"
            className={`w-full rounded-lg border px-4 py-2 text-sm text-foreground bg-background focus:outline-none focus:ring-2 focus:ring-primary ${
              touched && confirm && !isConfirmValid ? 'border-destructive' : 'border-border'
            }`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy}
          />

          {showRules && (
            <ul className="space-y-1 text-xs">
              <PasswordRuleItem met={rules.length} label="At least 8 characters" />
              <li className={`flex items-center gap-1.5 ${categoriesMet >= 3 ? 'text-success' : 'text-muted-foreground'}`}>
                {categoriesMet >= 3 ? <Check className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
                <span>At least 3 of: uppercase, lowercase, digit, special character ({categoriesMet}/3)</span>
              </li>
            </ul>
          )}

          {touched && confirm && !isConfirmValid && (
            <p className="text-xs text-destructive">Passwords do not match.</p>
          )}

          <button
            onClick={() => void handleSubmit()}
            disabled={busy || !password || !confirm}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? '...' : 'Set Password'}
          </button>
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}

function PasswordRuleItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${met ? 'text-success' : 'text-muted-foreground'}`}>
      {met ? <Check className="size-3.5 shrink-0" /> : <Circle className="size-3.5 shrink-0" />}
      <span>{label}</span>
    </li>
  );
}
