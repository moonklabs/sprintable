/**
 * story #2720(2026-08-17) — FE canonicalization SSOT.
 *
 * `apps/web/src/app/api/attachments/sign/route.ts`가 저장 url → canonical object path 규칙을
 * 자체 재구현하고 있었다(BE `asset_registry.canonical_object_path`와 "동일 규칙"이라는 주석만
 * 정합을 약속) — 이 파일이 그 FE 쪽 단일 구현이다. BE의 대응 SSOT(Python)는
 * `backend/app/services/asset_registry.py::canonical_object_path` — 두 언어라 코드 자체를
 * 공유할 수는 없지만(런타임이 다르다), 같은 입출력 규칙을 각자 언어로 고정해 대조 테스트로
 * 정합을 pin한다(story #2720 AC3).
 *
 * `URL` 파서 기반(문자열 `startsWith` 아님) — 서명 쿼리스트링(`?X-Goog-...`)이 붙은 url도
 * 안전하게 처리한다(쿼리는 파서가 `search`로 분리해주므로 path 매칭에 안 섞인다).
 */

const GCS_HOST = 'storage.googleapis.com';

/**
 * 저장 url → canonical object path. 우리 버킷(`container`) 객체가 아니면 null.
 * - GCS 퍼블릭 https url(`https://storage.googleapis.com/{container}/{path}`) → path 그대로.
 * - 스킴 없는 bare object path → 그대로(no-op passthrough).
 * - 다른 호스트/버킷/스킴 → null(우리 객체 아님 — 임의 URL 삽입 차단).
 */
export function canonicalObjectPath(stored: string, container: string): string | null {
  if (!stored) return null;
  if (stored.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(stored);
    } catch {
      return null;
    }
    if (parsed.hostname !== GCS_HOST) return null;
    const prefix = `/${container}/`;
    if (!parsed.pathname.startsWith(prefix)) return null;
    const objectPath = parsed.pathname.slice(prefix.length);
    return objectPath || null;
  }
  return stored;
}
