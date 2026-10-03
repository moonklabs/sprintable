import { PhonePairing } from '@/components/desktop/phone-pairing';

/**
 * story #4532 — 폰 앱 안에서 이 폰을 컴퓨터와 짝짓는 화면(명세 b0713c54 폰 표). 카메라 · QR 비밀 · MAC · 짝짓기 숫자는 폰 셸이 하고,
 * 이 화면은 단계를 그린다. 폰 앱 밖(브라우저 · 데스크톱 앱)에서는 «폰의 Sprintable 앱에서 열어 주세요» 한 줄. 로그인은 (authenticated) 가드.
 */
export default function DesktopPairPage() {
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <PhonePairing />
    </div>
  );
}
