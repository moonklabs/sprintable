// story #3755(BE·표시명·결함 클래스, 페드루 PO 決 2026-09-09) — BE resolver가 display_name
// 없는 휴먼 구성원을 이메일/id 문자열로 지어내는 대신 정직하게 name: null을 돌리도록 고친
// 뒤(member_resolver.py 5자리), FE 소비처가 그 null을 각자 다르게 다루던 것(같은 사실이
// 화면마다 다른 낱말로 뜨거나, 조용히 빈 칸으로 사라지던 것)을 한 헬퍼로 수렴한다.
// channel-label.ts의 (value, t) 시그니처와 동형 — 새 기전 발명 금지. 실 소비처(2026-09-09
// 기준): activity-log-view.tsx·dashboard-activity-timeline.tsx(활동 로그 actor) ·
// organization/events/page.tsx(이벤트 발행 이력 sender).
//
// 대화 참여자 화면(chats/[conversation_id]/page.tsx)은 이 헬퍼를 직접 못 쓴다 — 참여자
// payload가 「실존 구성원인데 display_name만 없음」과 「orphan(member/alias 자체가
// 없음)」 둘 다 name=None으로 채워서다(member_resolver.py orphan-fallback·실존-무이름
// 분기가 같은 신호를 남김). story #3758(9번째, PO 決 2026-09-09) — BE가 `ResolvedMember.
// resolved: bool` 비트를 신설해(orphan만 False) 참여자 payload에 그대로 흘려보내고,
// 아래 `participantDisplayLabel()`이 그 비트로 갈라 이 헬퍼를 우회 없이 쓴다.
//
// 유나 디자인 게이트 적기만②(2026-09-09) — `??`는 null/undefined만 잡고 빈 문자열은
// 그대로 통과시킨다. BE가 ""를 name으로 준 적은 실측 0건이지만(전부 None 아니면 실
// 문자열), 방어적으로 빈 문자열도 같은 폴백으로 묶는다 — "" 도 "이름 없음"과 같은 사실
// (표시할 이름이 없다)이라 다른 취급을 둘 이유가 없다.
export function memberDisplayLabel(name: string | null | undefined, t: (key: string) => string): string {
  return name ? name : t('memberUnnamed');
}

/** story #4284 — `/api/members` · `/api/team-members` 한 줄의 공용 모양. BE `team_members.name`은 nullable(표시 이름 없는 휴먼 · #3758)이라
 * `name: string | null` — 소비처가 인라인 `{ name: string }`으로 받으면 tsc가 null 소비를 못 잡는다(채팅 멘션 · 보드 필터가 그렇게 깨졌다). */
export interface MemberRow {
  id: string;
  name: string | null;
  type?: string;
  role?: string | null;
  runtime_type?: string | null;
}

/**
 * [SID:4286 · 유나 06:49Z] 행 꼬리 규칙은 **여기 한 곳**에만 정의한다 — memberRowLabels · disambiguateFallbackLabels가 둘 다 이것을 부른다
 * (두 헬퍼에 따로 살면 한쪽만 고쳐져 갈린다).
 * 규칙(#4284 · 4638 · 유나 결정 4 → story #4311 유나 확정 2026-09-25): 한 목록 안에서 **보이는 라벨 글자**가 같은 서로 다른 행이 둘 이상이면
 * 그 행에만 «· ID 앞 8자» 꼬리. 이름이 없어서 같든(«이름 없는 구성원») 이름이 같든(«송윤재») 똑같이 — 예전엔 폴백 행끼리만 갈라
 * 동명이인(배포 29 스탠드업 미작성 «송윤재» 둘)이 구분되지 않았다. 단 역할 라벨이 그 행들 사이에서 유일하면(행에 이미 보인다 ·
 * roleLabel을 넘기는 곳) 꼬리 없음. 타입(사람 · 에이전트)으로 나누지 않는다(아이콘은 aria-hidden · `<option>`엔 표식 없음).
 * 겹치지 않는 라벨은 그대로. `fallback`은 호출부 호환용으로 남긴 표시(판정엔 안 쓴다).
 */
function tailSharedFallbacks(
  items: ReadonlyArray<{ id: string; label: string; fallback?: boolean; role?: string }>,
): Map<string, string> {
  const groups = new Map<string, Map<string, string>>(); // 보이는 라벨 → (id → 역할)
  for (const it of items) {
    const g = groups.get(it.label) ?? groups.set(it.label, new Map()).get(it.label)!;
    g.set(it.id, it.role ?? '');
  }
  const out = new Map<string, string>();
  for (const it of items) {
    const group = groups.get(it.label)!;
    if (group.size < 2) { out.set(it.id, it.label); continue; }
    const role = it.role ?? '';
    const roleIsUnique = role !== '' && [...group.values()].filter((r) => r === role).length === 1;
    out.set(it.id, roleIsUnique ? it.label : `${it.label} · ${it.id.slice(0, 8)}`);
  }
  return out;
}

/** story #4284(유나 판정 · 4638 규칙) · story #4311 — 목록 **행** 라벨. 보이는 라벨이 같은 행(이름 없음 · 동명이인)이 둘 이상이면 서로 갈리게:
 * 역할 라벨이 그 행들 사이에서 유일하면 그걸로 충분(행에 이미 보인다) · 같거나 없으면 «· ID 앞 8자» 꼬리. 라벨이 겹치지 않으면 꼬리 없음.
 * 본문에 넣는 글자(예: 멘션 `@…`)엔 쓰지 않는다 — 그건 memberDisplayLabel 그대로.
 * [SID:4286] `baseLabel` — 행의 기본 라벨(기본 memberDisplayLabel). 타입 표식을 둘 수 없는 `<option>` 목록은 memberOrAgentLabel을 넘긴다(유나 규칙). */
export function memberRowLabels<T extends { id: string; name: string | null }>(
  rows: T[],
  t: (key: string) => string,
  roleLabel: (row: T) => string,
  baseLabel: (row: T) => string = (row) => memberDisplayLabel(row.name, t),
): Map<string, string> {
  return tailSharedFallbacks(rows.map((row) => ({ id: row.id, label: baseLabel(row), fallback: !row.name, role: roleLabel(row) })));
}

// story #4284 — id로 구성원 이름을 찾을 때 «목록에 있는데 이름이 없음»(→ memberDisplayLabel의 «이름 없는 구성원»)과
// «목록에 없음»(→ 호출부가 정한 unknownFallback · 예: «—»)을 가른다. 예전 `memberMap[id]?.name ?? fallback`은 이름이 null인 실존
// 구성원까지 fallback(id 조각 등)으로 떨어뜨려, 식별자를 이름처럼 보이던 #3755 클래스와 같은 모양이 됐다. `t`는 common 네임스페이스.
// [SID:4286] unknownFallback은 필수(4646 모양) — 호출부는 «알 수 없는 구성원»(t('memberUnknown'))을 넘긴다. id 조각 · id 통째는 넘기지 않는다(가드).
export function memberNameById(
  memberMap: Record<string, { name: string | null }> | undefined,
  id: string,
  t: (key: string) => string,
  unknownFallback: string,
): string {
  const member = memberMap?.[id];
  return member ? memberDisplayLabel(member.name, t) : unknownFallback;
}

// story #3758(9번째, PO 決 2026-09-09) — 대화 참여자 전용. `resolved === false`(진짜
// orphan — member/alias 해소 자체가 실패)는 tc('memberUnknown')(「알 수 없는 구성원」 · story #4286에서
// chats.unknownMember를 common.memberUnknown으로 모음) · 그 외(실존 구성원,
// 표시명만 없을 수 있음)는 memberDisplayLabel로 「이름 없는 구성원」/실명. activity-log-view.tsx
// auditActorProps(actor_id 유무로 가름)·publishHistorySenderLabel(sender_id 유무)과 같은
// 모양 — 여기는 신호가 BE가 직접 실어 보내는 `resolved` 비트라는 점만 다르다.
export function participantDisplayLabel(
  p: { name: string | null; resolved?: boolean },
  tc: (key: string) => string,
): string {
  // BE ResolvedMember.resolved 기본값(True)과 짝 — 필드 자체가 없는 호출부(레거시 캐시·
  // 아직 안 지나간 필드)는 "모른다"가 아니라 "실존"으로 읽는다. orphan만 명시 false.
  // [SID:4286] «알 수 없는 구성원»은 common.memberUnknown 하나로 모았다(chats.unknownMember 폐기 · PO 決).
  if (p.resolved === false) return tc('memberUnknown');
  return memberDisplayLabel(p.name, tc);
}

// story #3755 CHANGES(카디르 QA 지적 2026-09-09) — organization/events/page.tsx의
// PublishHistorySection용이었으나, `page.tsx`는 Next App Router가 named export 필드를
// 화이트리스트로 검사하는 특수 모듈이라(metadata/generateMetadata/revalidate 등 정해진
// 것 외 named export가 있으면 "is not a valid Page export field"로 next build가 실패
// — tsc/vitest는 이 층을 안 잡는다, 3757 뒤 별건 가드 후보) 일반 헬퍼는 여기로.
//
// sender_id는 있는데 sender_name이 null(실존 발신자, display_name 미설정)인 경우와
// sender_id 자체가 null(발신자 정보 자체가 없음)인 경우가 예전엔 둘 다
// eventPublishHistoryUnknownSender("알 수 없음")로 뭉뚱그려졌다 — activity-log-view.tsx
// auditActorProps와 동형 처방(sender_id 유무로 갈라 전자는 memberUnnamed).
export function publishHistorySenderLabel(
  item: { sender_id: string | null; sender_name: string | null },
  t: (key: string) => string,
  tc: (key: string) => string,
): string {
  if (!item.sender_id) return t('eventPublishHistoryUnknownSender');
  return memberDisplayLabel(item.sender_name, tc);
}

// [SID:4286] memberNameById 위에 두 갈래를 더한 조회(PO 決 2026-09-24 · 헬퍼 하나로 · 4646 뼈대):
//   표를 아직 불러오는 중 → null(호출부는 글자 없음 · 자리표시 — «알 수 없음»을 띄웠다가 곧 이름으로 바뀌면 거짓)
//   fallback 여부 → «님» 없는 문장 키를 고르게(유나 결정 4 · «알 수 없는 구성원의 결재…»)
// 표 값은 이름 문자열(memberNames 류)이든 { name } 객체(memberMap 류)든 받는다. 다른 프로젝트 구성원처럼 «표가 좁아서» 없는 것도
// 후속 카드 전까지는 «알 수 없는 구성원»으로 선다(누군지 모름은 거짓이 아니고 id 조각보다 정직 — PR 본문 지름길 표시).
// Object.hasOwn — 표가 평범한 객체라 'constructor' 같은 id가 프로토타입 값으로 새지 않게. 표 불러오기가 실패로 끝나도 loaded=true.
export function memberLookup(
  table: Readonly<Record<string, string | null | undefined | { name?: string | null }>> | undefined,
  id: string,
  t: (key: string) => string,
  opts: { loaded: boolean } = { loaded: true },
): { label: string; fallback: boolean } | null {
  if (table && Object.hasOwn(table, id)) {
    const v = table[id];
    const name = v && typeof v === 'object' ? v.name : v;
    return name ? { label: name, fallback: false } : { label: t('memberUnnamed'), fallback: true };
  }
  if (!opts.loaded) return null;
  return { label: t('memberUnknown'), fallback: true };
}

// [SID:4286 · 유나 결정 4] 한 목록 안에서 같은 글자(«알 수 없는 구성원» 등 · story #4311부터 동명이인 실명도)가 서로 다른 id 둘 이상에
// 서면 그 행에 id 앞 8자 꼬리를 붙여 가른다 — 규칙 정의는 tailSharedFallbacks 한 곳(memberRowLabels와 같은 규칙).
export function disambiguateFallbackLabels(
  items: ReadonlyArray<{ id: string; label: string; fallback: boolean }>,
): Map<string, string> {
  return tailSharedFallbacks(items);
}

/** [SID:4311 PR 3 · 유나 잘림 순서] 꼬리 붙은 행 라벨을 이름 · 꼬리로 나눈다 — 좁은 한 줄에서 이름만 먼저 잘리고 꼬리(«· ID 앞 8자»)는 늘 보이게
 * (RowName). 꼬리는 tailSharedFallbacks가 붙인 모양 그대로 `' · ' + id 앞 8자`라 행 id로 끝자리를 맞춰 가른다(이름 안의 « · »와 헷갈리지 않음).
 * 꼬리 없는 라벨 · id 없음 → 이름만. */
export function splitRowLabel(label: string, id: string | null | undefined): { name: string; tail: string | null } {
  const tail = id ? id.slice(0, 8) : '';
  const suffix = ` · ${tail}`;
  if (tail && label.length > suffix.length && label.endsWith(suffix)) return { name: label.slice(0, -suffix.length), tail };
  return { name: label, tail: null };
}

/** [SID:4311 PR 2] 이벤트 · 배지 줄(활동 피드 · 댓글 · 이력 · 막힘 모음 · 승인자 줄 · 회고 담당 칩)의 행위자 라벨 — 꼬리 규칙은 tailSharedFallbacks 한 곳.
 * 행이 아니라 **행위자 id마다 한 번** 센다(같은 사람이 여러 줄이어도 겹침 아님 · 유나). 행위자 없는 행(시스템 · id null)과 아직 라벨이 없는
 * 행(표를 받는 중 · 빈 글자)은 뺀다 — 호출부는 그 행에 원래 글자를 그대로 쓴다. 겹침 판정은 **지금 불러온 줄들** 안에서만(페이지 밖 동명이인은 모름). */
export function actorRowLabels(
  actors: Iterable<{ id: string | null | undefined; label: string | null | undefined }>,
): Map<string, string> {
  const seen = new Map<string, string>();
  for (const a of actors) {
    if (a.id && a.label && !seen.has(a.id)) seen.set(a.id, a.label);
  }
  return tailSharedFallbacks([...seen].map(([id, label]) => ({ id, label })));
}

/** [SID:4286 · 유나 규칙 06:48Z] 타입 표식을 둘 수 없는 선택 목록(네이티브 `<option>` · 드롭다운 선택지)의 행 라벨 — 이름 빔이면 타입대로
 * (에이전트 «이름 없는 에이전트» · 사람 «이름 없는 구성원») · 같은 라벨이 서로 다른 행 둘 이상이면 그 행에만 «· ID 앞 8자»
 * (꼬리 규칙은 tailSharedFallbacks 한 곳). 표식이 하나라도 있는 목록(원 아이콘 · 칩 · `<optgroup>`)은 memberRowLabels 기본(«이름 없는 구성원»)을 쓴다. */
export function memberOptionLabels<T extends { id: string; name: string | null; type?: string | null }>(
  rows: readonly T[],
  tc: (key: string) => string,
): Map<string, string> {
  return memberRowLabels([...rows], tc, () => '', (row) => memberOrAgentLabel(row, tc));
}

// [SID:4286 · 유나 결정 1 · 2] 사람 · 에이전트가 섞인 목록의 이름 칸 — 이름이 비면 에이전트는 «이름 없는 에이전트», 사람은 «이름 없는 구성원».
export function memberOrAgentLabel(
  m: { name?: string | null; type?: string | null },
  tc: (key: string) => string,
): string {
  if (m.name) return m.name;
  return m.type === 'agent' ? tc('agentUnnamed') : tc('memberUnnamed');
}
