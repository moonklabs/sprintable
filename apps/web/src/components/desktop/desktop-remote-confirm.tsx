'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story #4548 (E-DESKTOP-2 B-1 · 명세 모음 B-1 «②'» · 유나 «4548 서버 코드 ↔ 사람 문구» 표) — 이미 설정한 컴퓨터의 원격 제어를
 * 사람이 켜는 확인 한 장. 데스크톱 앱이 `#code=…`로 연다(계약 02d2cf71 §1.1). 코드는 사람에게 보이지 않고 본문으로만 간다.
 * 머리(컴퓨터 이름 · 조직)는 서버가 켤 수 있는 사람에게만 준다 — `not_org_admin`이면 머리 없이 «켤 수 없어요»만(남의 이름 0).
 * 결과 문단은 모두 `role="status"`(유나 10:26Z): [켜기] 뒤 단추가 사라져 초점이 떨어지니, 화면 읽기에 결과가 소리로 닿게.
 */
type View =
  | { kind: 'loading' }
  | { kind: 'ready'; device: string; org: string | null; busy: boolean }
  | { kind: 'done' }
  | { kind: 'expired' | 'spent' | 'notAdmin' | 'disconnected' | 'failed' };

const CODE_FIELD = 'code';

export function codeFromFragment(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/, '')).get(CODE_FIELD);
  return value && value.length >= 20 && value.length <= 128 ? value : null;
}

/** The server's closed code → the line the person sees (Yuna's table · 08:44Z). An unknown or spent code is «can't be used
 *  anymore», not «expired» (time may not have passed) — and never «켰어요» for something this page did not turn on. */
function viewOf(code: string | undefined): View {
  switch (code) {
    case 'code_expired':
      return { kind: 'expired' };
    case 'code_not_found':
    case 'code_used':
      return { kind: 'spent' };
    case 'not_org_admin':
      return { kind: 'notAdmin' };
    case 'setup_disconnected':
      return { kind: 'disconnected' };
    default:
      return { kind: 'failed' };
  }
}

async function post(path: string, code: string): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  try {
    const res = await fetchWithAuth(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  } catch {
    return { ok: false, body: null };
  }
}

const errorCode = (body: Record<string, unknown> | null) => (body?.error as { code?: string } | undefined)?.code;

export function DesktopRemoteConfirm() {
  const [code, setCode] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const strip = () => window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    const found = codeFromFragment(window.location.hash);
    if (window.location.hash) strip(); // off the address at once (log · Referer · screen share)
    void Promise.resolve().then(() => setCode(found));
    // after a sign-in the app may reopen the same page with its `#` — a fragment change, not a new load (as the setup page)
    const onHash = () => {
      const next = codeFromFragment(window.location.hash);
      if (!next) return;
      strip();
      setCode(next);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  if (code === undefined) return null;
  return code ? <Confirm key={code} code={code} /> : <OpenFromApp />;
}

function OpenFromApp() {
  const t = useTranslations('desktop.remote');
  return (
    <Card className="break-keep p-6">
      <p className="text-sm text-muted-foreground">{t('noCode')}</p>
    </Card>
  );
}

function Confirm({ code }: { code: string }) {
  const t = useTranslations('desktop.remote');
  const flat = useFlatHref();
  const [view, setView] = useState<View>({ kind: 'loading' });

  const peek = useCallback(async () => {
    setView({ kind: 'loading' });
    const { ok, body } = await post('/api/desktop/device-token-codes/peek', code);
    if (ok && body && typeof body.device_name === 'string') {
      setView({ kind: 'ready', device: body.device_name, org: typeof body.org_name === 'string' ? body.org_name : null, busy: false });
    } else {
      setView(viewOf(errorCode(body)));
    }
  }, [code]);

  useEffect(() => {
    void Promise.resolve().then(peek);
  }, [peek]);

  const turnOn = async () => {
    if (view.kind !== 'ready') return;
    setView({ ...view, busy: true });
    const { ok, body } = await post('/api/desktop/device-token-codes/confirm', code);
    setView(ok ? { kind: 'done' } : viewOf(errorCode(body)));
  };

  if (view.kind === 'loading') {
    return <Card className="p-6"><Loader2 className="size-4 animate-spin" aria-label={t('loading')} /></Card>;
  }
  if (view.kind === 'ready') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6">
        <h1 className="text-lg font-semibold">{t('title')}</h1>
        <p className="text-sm font-medium">{view.org ? t('head', { device: view.device, org: view.org }) : view.device}</p>
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        <p className="text-sm text-muted-foreground">{t('agentsStay')}</p>
        <div className="flex gap-2">
          <Button onClick={turnOn} disabled={view.busy}>
            {view.busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('turnOn')}
          </Button>
          <Button variant="outline" asChild><a href={flat('/desktop')}>{t('cancel')}</a></Button>
        </div>
      </Card>
    );
  }
  if (view.kind === 'done') {
    return <Card className="break-keep p-6"><p className="text-sm" role="status">{t('done')}</p></Card>;
  }
  if (view.kind === 'notAdmin') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6">
        <h1 className="text-lg font-semibold">{t('cantTitle')}</h1>
        <p className="text-sm text-muted-foreground" role="status">{t('notAdmin')}</p>
      </Card>
    );
  }
  if (view.kind === 'disconnected') {
    return (
      <Card className="break-keep flex flex-col gap-3 p-6">
        <p className="text-sm text-muted-foreground" role="status">{t('disconnected')}</p>
        <div><Button variant="outline" asChild><a href={flat('/desktop')}>{t('devicesAction')}</a></Button></div>
      </Card>
    );
  }
  if (view.kind === 'expired' || view.kind === 'spent') {
    return <Card className="break-keep p-6"><p className="text-sm text-muted-foreground" role="status">{view.kind === 'expired' ? t('expired') : t('spent')}</p></Card>;
  }
  return (
    <Card className="break-keep flex flex-col gap-3 p-6">
      <p className="text-sm text-muted-foreground" role="status">{t('failed')}</p>
      <div><Button variant="outline" onClick={() => void peek()}>{t('retry')}</Button></div>
    </Card>
  );
}
