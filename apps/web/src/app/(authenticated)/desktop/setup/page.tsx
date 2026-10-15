import { DesktopSetupEntry } from '@/components/desktop/desktop-setup';

/**
 * story #4427(E-DESKTOP P2) — 첫 실행 설정의 웹 페이지. 데스크톱 앱이 `#code=…&setup=…&runtimes=…`로 연다(데스크톱 전용 화면 X).
 * 설정 값은 `#` 뒤라 서버로 가지 않는다(요청 로그 · Referer에 코드 0 — PO 09:45Z). 그래서 이 페이지는 서버에서 값을 읽지 않고,
 * 브라우저에서 읽은 뒤 주소에서 지운다(DesktopSetupEntry). 값이 없거나 틀리면(브라우저로 직접 온 경우 · AC5)
 * «데스크톱 앱에서 열어 주세요». 로그인은 (authenticated) 가드가 맡는다.
 */
export default function DesktopSetupPage() {
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <DesktopSetupEntry />
    </div>
  );
}
