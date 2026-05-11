'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { SprintableLogo } from '@/components/brand/sprintable-logo';

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

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const rules = checkPasswordRules(password);
  const categoriesMet = countCategories(rules);
  const isPasswordValid = rules.length && categoriesMet >= 3;

  const handleRegister = async () => {
    if (!email.trim() || !password.trim()) return;
    if (!isPasswordValid) {
      setPasswordTouched(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const json = await res.json() as { data?: { ok: boolean }; error?: { message: string } };
      if (!res.ok || !json.data?.ok) {
        setError(json.error?.message ?? 'Registration failed. Please try again.');
        return;
      }
      const meRes = await fetch('/api/me');
      const meJson = await meRes.json() as { data?: { org_id?: string } };
      router.push(meJson.data?.org_id ? '/inbox' : '/onboarding');
      router.refresh();
    } catch {
      setError('Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const showRules = passwordTouched && password.length > 0;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-2xl bg-white p-4 shadow-lg sm:p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <SprintableLogo
            variant="stacked"
            className="text-gray-900"
            markClassName="h-14"
            wordmarkClassName="h-5"
          />
          <p className="text-sm text-gray-500">Create your account</p>
        </div>

        <div className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            autoComplete="email"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            disabled={loading}
          />
          <input
            type="password"
            placeholder="Password"
            autoComplete="new-password"
            className={`w-full rounded-lg border px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              showRules && !isPasswordValid ? 'border-red-400' : 'border-gray-300'
            }`}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setPasswordTouched(true); }}
            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
            disabled={loading}
          />
          {showRules && (
            <ul className="space-y-1 text-xs">
              <RuleItem met={rules.length} label="At least 8 characters" />
              <li className={`flex items-center gap-1.5 ${categoriesMet >= 3 ? 'text-green-600' : 'text-gray-400'}`}>
                <span>{categoriesMet >= 3 ? '✓' : '○'}</span>
                <span>At least 3 of: uppercase, lowercase, digit, special character ({categoriesMet}/3)</span>
              </li>
            </ul>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            onClick={handleRegister}
            disabled={loading || !email.trim() || !password.trim()}
            className="flex w-full min-h-[44px] items-center justify-center rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Creating account...' : 'Sign up'}
          </button>
        </div>

        <p className="text-center text-sm text-gray-500">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-blue-600 hover:text-blue-700">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function RuleItem({ met, label }: { met: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${met ? 'text-green-600' : 'text-gray-400'}`}>
      <span>{met ? '✓' : '○'}</span>
      <span>{label}</span>
    </li>
  );
}
