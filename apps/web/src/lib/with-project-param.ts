/**
 * story #4226 · #4231 — 주소에 `?p={프로젝트}`를 싣는 순수 함수(훅 없는 곳 · 순환 import 피하는 곳에서도 쓰도록 lib로 둔다).
 * 기존 쿼리·해시 보존 · 이미 실은 `p`는 그대로(일부러 다른 프로젝트로 보내는 링크를 덮지 않는다 · #4231) · 프로젝트를 모르면 주소 그대로.
 */
export function withProjectParam(href: string, projectId: string | null | undefined): string {
  if (!projectId) return href;
  const [pathAndQuery, hash = ''] = href.split('#');
  const [path, query = ''] = pathAndQuery!.split('?');
  const sp = new URLSearchParams(query);
  if (sp.has('p')) return href;
  // story #4231 3차 — 기존 쿼리는 **글자 그대로** 두고 `p`만 덧붙인다(URLSearchParams로 다시 쓰면 compose 같은 값의 `%20`이 `+`로
  // 바뀌는 등 주소의 다른 부분을 건드린다 — 첫 지시 이동 테스트가 잡았다).
  const tail = `p=${encodeURIComponent(projectId)}`;
  return `${path}?${query ? `${query}&${tail}` : tail}${hash ? `#${hash}` : ''}`;
}

/**
 * story #4231 3차 — «이동하지 않는» 판정 전용(예: 이 엔티티에 자기 주소가 있나 `!== null`). 프로젝트를 싣지 않는다 —
 * 링크·이동에 쓰면 bare flat 목적지가 된다(그 자리엔 useFlatHref · withProjectParam).
 */
export function keepHref(href: string): string {
  return href;
}
