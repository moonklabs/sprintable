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
  if (
    values.originalBytes !== null && values.finalBytes !== null
    && values.originalBytes !== values.finalBytes
  ) {
    fragments.push(t('channelPostsImageConvertedBadgeBytesFragment', {
      from: formatFileSize(values.originalBytes), to: formatFileSize(values.finalBytes),
    }));
  }
  return fragments.length > 0 ? `${base}: ${fragments.join(' · ')}` : `${base}.`;
}
