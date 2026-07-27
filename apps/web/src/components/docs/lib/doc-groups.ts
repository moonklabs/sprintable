// story #2193 — 문서 트리 자동 그룹핑. 사람이 폴더에 담았는지와 무관하게, slug가 이미
// 규칙적으로 갖고 있는 접두어(e-canvas-, policy-, blueprint- 등)로 문서를 묶는다.
// 그라운딩(유나양 doc-tree-diagnosis-retro): 폴더는 실사용률이 낮다(정책 문서 44개 중 57%만
// 폴더 안) — "그릇이 있으면 담긴다"가 거짓이므로, 담김 여부와 무관하게 같은 slug 접두어를
// 가진 문서를 한 그룹으로 묶어 폴더 성패를 무해하게 만든다.

export interface GroupableDoc {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
}

export interface DocGroup {
  key: string;
  label: string;
  /** 이미 어떤 폴더(parent_id 있음)에 담긴 멤버 — 실제 폴더 계층과 무관하게 평면 나열된다. */
  inFolder: GroupableDoc[];
  /** 폴더 밖(parent_id 없음, 즉 트리 루트)에 흩어진 멤버. */
  looseAtRoot: GroupableDoc[];
}

export interface DocGroupingResult {
  groups: DocGroup[];
  /** 접두어 규칙이 약해 어떤 그룹에도 못 들어간 문서 — 시간 그릇의 재료(#2193 AC2, created_at
   * 필드 부재로 현재는 세분화하지 않고 하나로 묶는다. backend 확장 뒤 시간별로 나눌 슬롯). */
  ungrouped: GroupableDoc[];
}

// 그룹 하나가 "우연"이 아니라 "규칙"이라고 볼 최소 크기 — 임의값이 아니라 실측 기반이다.
// 실 프로젝트 문서 500건 샘플(#2191 절단 안쪽, 아래 참고)에서 2-토큰 접두어 빈도를 세어보면
// 2 이하는 "우연히 같은 단어로 시작하는 개별 문서 한둘"(예: blueprint-e·handoff-e 조합)이
// 대부분이고, 3부터 e-storage(6)·e-admin(6)·e-recruit(5)·e-eventbus(5)·e-verify(3)·e-glance(3)
// 처럼 실제로 반복되는 접두어로 바뀐다. 2로 낮추면 노이즈 그룹이 늘고, 5로 올리면 e-verify·
// e-glance 같은 실제 그룹을 놓친다 — 조정 가능하지만 바꾸려면 실측(위와 같은 빈도 분석)을
// 다시 거칠 것.
//
// ⚠️ 이 값·아래 groups 크기 자체가 참고하는 doc slug 표본은 #2191(트리 500건 절단)이 아직
// 안 고쳐진 상태에서 잰 것 — BE가 500건 넘게 못 돌려주므로 619건 전체가 아니라 그 안쪽
// 500건 위에서 관찰한 분포다. #2191이 착지해 전체 619건이 들어오면 그룹 크기(특히 상대적
// 순위)가 달라질 수 있어 재확인이 필요하다.
const MIN_GROUP_SIZE = 3;

function tokenize(slug: string): string[] {
  return slug.split('-').filter(Boolean);
}

function labelFor(key: string): string {
  return key.split('-').map((t) => t.toUpperCase()).join('-');
}

function toGroup(key: string, members: GroupableDoc[]): DocGroup {
  return {
    key,
    label: labelFor(key),
    inFolder: members.filter((d) => d.parent_id !== null),
    looseAtRoot: members.filter((d) => d.parent_id === null),
  };
}

/**
 * slug 접두어로 문서를 그룹핑한다. 2-토큰 접두어(e-canvas, e-mobile 등 — 이 프로젝트의
 * "E-" 에픽 slug 컨벤션이 실측상 두 토큰인 경우가 많다)를 우선 시도하고, 그걸로 최소
 * 크기를 못 채우는 문서는 1-토큰 접두어(policy, blueprint, design 등)로 재시도한다.
 * 두 시도 모두 실패하면 ungrouped로 떨어진다.
 *
 * parent_id(실제 폴더 소속 여부)는 그룹 배정 자체에는 영향을 주지 않는다 — 그룹은 순수
 * slug 기반이고, parent_id는 그룹 "안에서" inFolder/looseAtRoot로 나누는 데만 쓰인다.
 * 이게 AC5(폴더 성패 무해화)의 핵심: 같은 slug 접두어를 가진 문서는 폴더에 담겼든 안
 * 담겼든 항상 같은 그룹에 함께 보인다.
 */
export function computeDocGroups(docs: GroupableDoc[]): DocGroupingResult {
  const twoToken = new Map<string, GroupableDoc[]>();
  const oneToken = new Map<string, GroupableDoc[]>();

  for (const doc of docs) {
    const tokens = tokenize(doc.slug);
    if (tokens.length >= 2) {
      const key = `${tokens[0]}-${tokens[1]}`;
      const list = twoToken.get(key);
      if (list) list.push(doc); else twoToken.set(key, [doc]);
    }
    if (tokens.length >= 1) {
      const key = tokens[0]!;
      const list = oneToken.get(key);
      if (list) list.push(doc); else oneToken.set(key, [doc]);
    }
  }

  const assigned = new Set<string>();
  const groups: DocGroup[] = [];

  const twoTokenEntries = [...twoToken.entries()]
    .filter(([, list]) => list.length >= MIN_GROUP_SIZE)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of twoTokenEntries) {
    list.forEach((d) => assigned.add(d.id));
    groups.push(toGroup(key, list));
  }

  const oneTokenEntries = [...oneToken.entries()]
    .map(([key, list]) => [key, list.filter((d) => !assigned.has(d.id))] as const)
    .filter(([, list]) => list.length >= MIN_GROUP_SIZE)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of oneTokenEntries) {
    list.forEach((d) => assigned.add(d.id));
    groups.push(toGroup(key, list));
  }

  const ungrouped = docs.filter((d) => !assigned.has(d.id));
  return { groups, ungrouped };
}
