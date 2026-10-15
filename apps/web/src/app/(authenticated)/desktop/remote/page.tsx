import { DesktopRemoteConfirm } from '@/components/desktop/desktop-remote-confirm';

/**
 * story #4548 — 이미 설정한 컴퓨터의 원격 제어를 사람이 켜는 웹 확인 한 장. 데스크톱 앱 [이 컴퓨터에서 켜기]가 `#code=…`로 연다.
 * 값은 `#` 뒤라 서버로 가지 않는다(요청 로그 · Referer에 0) — 브라우저에서 읽고 주소에서 바로 지운다. 로그인은 (authenticated) 가드.
 */
export default function DesktopRemotePage() {
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <DesktopRemoteConfirm />
    </div>
  );
}
