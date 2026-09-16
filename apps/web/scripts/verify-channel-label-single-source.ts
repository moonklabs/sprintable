/**
 * story #3742 — 채널 표시명(Threads·Instagram·Facebook·WordPress·웹훅·스티비…) 키가
 * `content`·`channelConnect`·`organization` 세 네임스페이스에 통째로 복제돼 살고 있었다
 * (#4082/3737이 `organization`에 10개를 복제하며 시작 — 그 뒤 새 채널이 등록될 때마다
 * 세 곳에 똑같이 등재해야 했고, 19키·57중복 leaf까지 불었다). `verify-no-duplicate-i18n-keys`
 * 는 같은 부모 안 sibling 중복만 봐서 이 클래스(다른 네임스페이스에 같은 키 이름+같은 값이
 * 복제)를 원리상 못 잡는다.
 *
 * 이 스토리에서 근본(channelLabel → useChannelLabel 훅, 정본 네임스페이스를 `channelConnect`
 * 하나로 고정)도 같이 처리해 content·organization의 복제 키 19개(ko/en 각 38줄)를 실제로
 * 걷었다 — 이 가드는 그 «단일 출처» 계약이 미래에도 유지되는지를 CI에서 상시 잰다.
 *
 * 축 둘:
 *   ㉠ 단일 출처 — CHANNEL_LABEL_KEYS(channel-label.ts, 손으로 안 베낌·거기서 파생)의 키
 *      이름이 `channelConnect` 밖 어느 네임스페이스에도 다시 나타나면 RED(재복제 재발 감지).
 *   ㉡ 완전성 — CHANNEL_LABEL_KEYS의 키 이름 전부가 `channelConnect`에 실존해야 한다(정본
 *      네임스페이스 자체가 빠진 채널을 갖고 있으면 RED — completeness는 channel-label.test.ts
 *      가 FE 채널 목록 19종과 대조해 이미 지키지만, 이 가드는 «네임스페이스 배치» 축이라
 *      독립적으로 다시 잰다).
 *
 * ⚠️이 가드가 «못 잡는» 것: 값 자체의 정확성(낱말이 맞는지)·en.json 누락(다른 가드
 * verify-i18n-keys-exist가 이미 짐)·CHANNEL_LABEL_KEYS 자체에 없는 새 채널 코드가
 * channelLabel() 폴백(원문 그대로)으로 새는 것(channel-label.test.ts 완전성 가드 소관).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHANNEL_LABEL_KEYS } from '../src/lib/channel-label';

export const CANONICAL_NAMESPACE = 'channelConnect';

export interface DuplicationViolation {
  namespace: string;
  key: string;
}

/** 정본 네임스페이스(channelConnect) 밖에서 CHANNEL_LABEL_KEYS 키 이름이 재등장하면 위반. */
export function findDuplicatedChannelLabelKeys(
  messages: Record<string, unknown>,
  channelLabelKeys: readonly string[],
): DuplicationViolation[] {
  const violations: DuplicationViolation[] = [];
  for (const [ns, nsValue] of Object.entries(messages)) {
    if (ns === CANONICAL_NAMESPACE) continue;
    if (nsValue === null || typeof nsValue !== 'object' || Array.isArray(nsValue)) continue;
    const nsObj = nsValue as Record<string, unknown>;
    for (const key of channelLabelKeys) {
      if (key in nsObj) violations.push({ namespace: ns, key });
    }
  }
  return violations;
}

/** channelConnect 자체에 CHANNEL_LABEL_KEYS 전부가 실존하는지(정본이 스스로 빠뜨리면 위반). */
export function findMissingFromCanonical(
  messages: Record<string, unknown>,
  channelLabelKeys: readonly string[],
): string[] {
  const canonical = messages[CANONICAL_NAMESPACE];
  const canonicalObj =
    canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical)
      ? (canonical as Record<string, unknown>)
      : {};
  return channelLabelKeys.filter((key) => !(key in canonicalObj));
}

function loadMessages(filePath: string): Record<string, unknown> {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

// self-assert — CHANNEL_LABEL_KEYS 파생 자체가 헛돌면(import 경로 깨짐 등) 조용한 「위반
// 0」 대신 죽는다(#3164/#2710류 fail-loud 관례). 실측 19개 — 여유 하한 10(story #3742
// 최초 판정 수, 미래에 채널이 늘면 자연히 넘는다).
const MIN_EXPECTED_KEYS = 10;

function main(): number {
  const channelLabelKeys = Object.values(CHANNEL_LABEL_KEYS);
  if (channelLabelKeys.length < MIN_EXPECTED_KEYS) {
    console.error(
      `FAIL: CHANNEL_LABEL_KEYS가 ${channelLabelKeys.length}개뿐 — channel-label.ts import 경로가 ` +
        '깨졌거나 이 가드가 헛돌고 있다.',
    );
    return 1;
  }

  let failed = false;
  for (const locale of ['ko', 'en']) {
    const filePath = path.join(MESSAGES_DIR, `${locale}.json`);
    let messages: Record<string, unknown>;
    try {
      messages = loadMessages(filePath);
    } catch (e) {
      console.error(`FAIL: ${locale}.json을 못 읽거나 파싱 실패 — ${(e as Error).message}`);
      return 1;
    }

    const dups = findDuplicatedChannelLabelKeys(messages, channelLabelKeys);
    const missing = findMissingFromCanonical(messages, channelLabelKeys);

    console.log(
      `[story #3742] ${locale}.json 채널 라벨 단일 출처 스캔 — CHANNEL_LABEL_KEYS ${channelLabelKeys.length}개 · ` +
        `정본(${CANONICAL_NAMESPACE}) 밖 재복제 ${dups.length}건 · 정본 누락 ${missing.length}건`,
    );

    if (dups.length > 0) {
      failed = true;
      console.error(`\nFAIL(${locale}): ${CANONICAL_NAMESPACE} 밖에서 채널 라벨 키가 재발견됨(단일 출처 위반):`);
      for (const d of dups) console.error(`  - ${d.namespace}.${d.key}`);
      console.error(`\n→ 채널 라벨은 ${CANONICAL_NAMESPACE} 네임스페이스 하나만 정본이다. 다른 네임스페이스에 복제하지 말고 useChannelLabel() 훅을 부를 것.`);
    }
    if (missing.length > 0) {
      failed = true;
      console.error(`\nFAIL(${locale}): ${CANONICAL_NAMESPACE}에 CHANNEL_LABEL_KEYS 일부가 없음:`);
      for (const key of missing) console.error(`  - ${key}`);
    }
  }

  if (failed) return 1;

  console.log(`\nOK: 채널 라벨 키 전부 ${CANONICAL_NAMESPACE} 단일 출처(다른 네임스페이스 재복제 0·정본 누락 0), ko/en 둘 다.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
