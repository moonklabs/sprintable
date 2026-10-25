import { PhonePairing } from '@/components/desktop/phone-pairing';
import { PAIR_RETURN_PARAM, safeReturnPath } from '@/lib/pair-return';

/**
 * story #4532 — 폰 앱 안에서 이 폰을 컴퓨터와 짝짓는 화면(명세 b0713c54 폰 표). 카메라 · QR 비밀 · MAC · 짝짓기 숫자는 폰 셸이 하고,
 * 이 화면은 단계를 그린다. 폰 앱 밖(브라우저 · 데스크톱 앱)에서는 «폰의 Sprintable 앱에서 열어 주세요» 한 줄. 로그인은 (authenticated) 가드.
 * story 4780 — `?from=` (들어온 화면)을 [닫기]의 돌아갈 곳으로 넘긴다. 앱의 폰 화면 몇 곳만 받고(lib/pair-return) 아니면 `/desktop`.
 */
export default async function DesktopPairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams)[PAIR_RETURN_PARAM];
  const returnTo = safeReturnPath(Array.isArray(raw) ? raw[0] : raw);
  return (
    <div className="mx-auto w-full max-w-2xl p-6">
      <PhonePairing returnTo={returnTo} />
    </div>
  );
}
