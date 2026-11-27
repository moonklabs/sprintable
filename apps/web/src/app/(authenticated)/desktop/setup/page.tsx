import { DesktopSetupEntry } from '@/components/desktop/desktop-setup';
import { serverHostMode } from '@/lib/server-host-mode';

/**
 * story #4427(E-DESKTOP P2) — 첫 실행 설정의 웹 페이지. 데스크톱 앱이 `#code=…&setup=…&runtimes=…`로 연다(데스크톱 전용 화면 X).
 * 설정 값은 `#` 뒤라 서버로 가지 않는다(요청 로그 · Referer에 코드 0 — PO 09:45Z). 그래서 이 페이지는 서버에서 값을 읽지 않고,
 * 브라우저에서 읽은 뒤 주소에서 지운다(DesktopSetupEntry). 값이 없거나 틀리면(브라우저로 직접 온 경우 · AC5)
 * «데스크톱 앱에서 열어 주세요». 로그인은 (authenticated) 가드가 맡는다.
 * story 5036 (C6): 서버에서 «서버 호스트인가»만 읽어 내려준다 — 조직 0인 앱 새 계정을 첫 실행 줄(/onboarding)로 보낼지 가르는 한 조건(서버 호스트의 온보딩은 줄이 없다).
 */
export default async function DesktopSetupPage() {
  const serverHost = await serverHostMode();
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <DesktopSetupEntry serverHost={serverHost.host} />
    </div>
  );
}
