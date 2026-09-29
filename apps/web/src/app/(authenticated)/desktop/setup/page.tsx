import { DesktopSetup, OpenInDesktopApp } from '@/components/desktop/desktop-setup';
import { parseSetupQuery } from '@/lib/desktop-setup';

/**
 * story #4427(E-DESKTOP P2) — 첫 실행 설정의 웹 페이지. 데스크톱 앱이 `?code=…&runtimes=…`로 연다(데스크톱 전용 화면 X).
 * 코드가 없거나 모양이 틀리면(브라우저로 직접 온 경우 · AC5) «데스크톱 앱에서 열어 주세요». 로그인은 (authenticated) 가드가
 * 맡는다 — 앱 안에서 로그인 전이면 로그인 뒤 이 주소로 돌아온다.
 */
export default async function DesktopSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === 'string' ? v : null; };
  const query = parseSetupQuery({ get: one });
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      {query ? <DesktopSetup code={query.code} runtimes={query.runtimes} blocked={query.blocked} /> : <OpenInDesktopApp />}
    </div>
  );
}
