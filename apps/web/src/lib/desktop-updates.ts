// [SID:3807] 슬라이스12 AC2(PO 確定 2026-09-11) — 데스크톱 컴패니언(sprintable-mobile)의
// check_for_updates가 WEB_ORIGIN에서 파생하는 경로({WEB_ORIGIN}/desktop/updates/macos.json)를
// 여기서 받는다. 매니페스트 원본은 이 레포가 손으로 안 짓는다 — mobile 레포 CI(PR #95)가
// 실 빌드·실 서명해서 공개읽기 GCS 버킷(gs://sprintable-desktop-releases-dev)의
// macos/latest/macos.json에 올려둔 걸 그대로 중계만 한다.

const GCS_MANIFEST_URL =
  'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos/latest/macos.json';

export class DesktopManifestUnavailableError extends Error {}

/** GCS의 실 매니페스트를 그대로 가져온다(파싱·재조립 0 — 원문 그대로 중계). */
export async function fetchDesktopUpdateManifest(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(GCS_MANIFEST_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new DesktopManifestUnavailableError(
      `GCS manifest fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}
