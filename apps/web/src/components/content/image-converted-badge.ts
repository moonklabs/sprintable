import { formatFileSize } from '@/components/docs/extensions/file-node';

// story #3563(유나 24회차 결함·§13-3-1 정본, 페드루 PO 確定 2026-09-06) — 자동 변환
// 배지가 "안 바뀐 축"을 `A → B`(변화형)로 적어 실제로 안 바뀐 값을 바뀐 것처럼
// 보이게 했다(「너비 1080px → 1080px」). `A → B` 화살표는 "두 값이 다르다"는
// 약속이라(§13-3-1), 값이 같으면 그 조각을 통째로 뺀다 — 기본 문장 + 축 조각
// 2(너비·용량)를 `·`로 잇되 값이 바뀐 축만 붙이고, 둘 다 안 바뀌었으면 조각 없이
// 기본 문장만(마침표로 끝맺음). null(값 자체가 없음)도 "안 바뀐 것과 같은 축"으로
// 취급해 조각을 뺀다(비교 불능이지 변화를 단정할 근거가 없다).
export function formatImageConvertedBadge(
  values: { originalWidth: number | null; finalWidth: number | null; originalBytes: number | null; finalBytes: number | null },
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  const base = t('channelPostsImageConvertedBadgeBase');
  const fragments: string[] = [];
  if (
    values.originalWidth !== null && values.finalWidth !== null
    && values.originalWidth !== values.finalWidth
  ) {
    fragments.push(t('channelPostsImageConvertedBadgeWidthFragment', {
      from: values.originalWidth, to: values.finalWidth,
    }));
  }
  if (values.originalBytes !== null && values.finalBytes !== null) {
    // 유나 Design 조건 1(2026-09-06) — 판정을 원시 바이트로 하면 10,300B와
    // 10,340B처럼 다른 값이 `formatFileSize` 뒤 같은 문자열("10.1 KB")로
    // 반올림돼 "용량 10.1 KB → 10.1 KB"가 그대로 뜬다(너비와 같은 병 — §13-3-1
    // "A → B는 두 값이 다르다는 약속"). 화면에 실제로 «보이는 문자열» 기준으로
    // 판정한다(너비는 정수 그대로라 이 문제가 없다 — 현행 유지).
    const from = formatFileSize(values.originalBytes);
    const to = formatFileSize(values.finalBytes);
    if (from !== to) {
      fragments.push(t('channelPostsImageConvertedBadgeBytesFragment', { from, to }));
    }
  }
  return fragments.length > 0 ? `${base}: ${fragments.join(' · ')}` : `${base}.`;
}
