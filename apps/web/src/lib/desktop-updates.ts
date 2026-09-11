// [SID:3807] 슬라이스12 AC2(PO 確定 2026-09-11) — 데스크톱 컴패니언(sprintable-mobile)의
// check_for_updates가 WEB_ORIGIN에서 파생하는 경로({WEB_ORIGIN}/desktop/updates/macos.json)를
// 여기서 받는다. 매니페스트 원본은 이 레포가 손으로 안 짓는다 — mobile 레포 CI(PR #95)가
// 실 빌드·실 서명해서 공개읽기 GCS 버킷(gs://sprintable-desktop-releases-dev)의
// macos/latest/macos.json에 올려둔 걸 그대로 중계만 한다.

const GCS_MANIFEST_URL =
  'https://storage.googleapis.com/sprintable-desktop-releases-dev/macos/latest/macos.json';

export class DesktopManifestUnavailableError extends Error {}

// [SID:3811] mobile CI가 이 객체를 no-cache 메타데이터로 올리는 쪽이 1차 방어(원인 쪽 수정,
// sprintable-mobile#… 워크플로) — 이 fetch의 no-store는 이 프로세스 자신의 캐시만 끈다.
// GCS 앞단(CDN·엣지)이 그 메타데이터를 못 읽거나 아직 반영 전이어도(실측: 릴리스 직후
// 프런트 노드마다 세대가 갈렸다) 매번 다른 쿼리스트링을 붙이면 URL 키 캐시 자체가 안 먹혀
// 이중으로 막힌다 — 어느 한쪽이 빠져도 서게.
function cacheBustedManifestUrl(): string {
  // Date.now()만 쓰면 같은 밀리초 안의 두 호출이 같은 URL이 될 수 있다(타이밍에 기대는 값은
  // 테스트도 실사용도 불안정하게 만든다) — 난수를 더해 항상 다른 쿼리스트링을 보장한다.
  const nonce = Math.random().toString(36).slice(2);
  return `${GCS_MANIFEST_URL}?_t=${Date.now()}-${nonce}`;
}

/** GCS의 실 매니페스트를 그대로 가져온다(파싱·재조립 0 — 원문 그대로 중계). */
export async function fetchDesktopUpdateManifest(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(cacheBustedManifestUrl(), { cache: 'no-store' });
  if (!res.ok) {
    throw new DesktopManifestUnavailableError(
      `GCS manifest fetch failed: ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}
