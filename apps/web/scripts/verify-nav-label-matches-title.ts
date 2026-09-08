/**
 * story #5f709b45(IA·FE·「같은 화면 두 세계」, 유나 § 確定 2026-09-08) — 사이드바 nav 라벨과
 * 그 항목이 착지하는 화면 자신의 제목이 다른 낱말이면, 라벨만 보고 들어간 사람이 "다른
 * 화면인가" 헷갈린다(org-workforce 「워크포스」→「에이전트」가 실측 사례 — 라벨이 화면
 * 실체보다 더 넓은 약속을 했다). 이 가드는 그 «클래스»가 다시 안 벌어지게 손으로 확認한
 * 짝(NAV_TITLE_PAIRINGS)만 대조한다.
 *
 * ⛔이 가드가 «못 잡는» 것(유나 정직 고지, 스토리 본문 "자 한계") — 자동 스윕(nav_label_
 * vs_title.cjs)은 후보 생성기일 뿐 판정 아니다(org-briefing을 "실험실"·인사문구로 2회
 * 오탐). 그래서 이 파일은 스윕을 재현하지 않는다 — PAIRINGS는 사람이 파일을 직접 열어
 * 대조한 것만 등재한다. 새 nav 항목이 생겨도 이 표에 자동으로 안 늘지 않는다(자동 발견은
 * 스코프 밖 — 늘리려면 사람이 이 배열에 손으로 추가).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');

export interface NavTitlePairing {
  /** nav-config.ts의 NavItemConfig.id — 사람이 읽는 이름표(가드 자체는 안 씀). */
  navItemId: string;
  /** 'nav' 네임스페이스 안의 키. */
  navKey: string;
  /** 착지 화면 제목이 사는 네임스페이스. */
  titleNamespace: string;
  /** 그 네임스페이스 안의 키. */
  titleKey: string;
}

// story #5f709b45 — 손 확認 5자리(못 잰 3 중 inbox·board는 이미 일치라 대상 제외, standup은
// 신규 편입). org-members는 제목 자체가 없어(섹션 h2만) 이 표 밖(별건).
export const NAV_TITLE_PAIRINGS: readonly NavTitlePairing[] = [
  { navItemId: 'retro', navKey: 'retro', titleNamespace: 'retro', titleKey: 'title' },
  { navItemId: 'standup', navKey: 'standup', titleNamespace: 'standup', titleKey: 'title' },
  { navItemId: 'org-trust', navKey: 'orgTrust', titleNamespace: 'organization', titleKey: 'trustSlotTitle' },
  { navItemId: 'docs', navKey: 'docs', titleNamespace: 'docs', titleKey: 'title' },
  { navItemId: 'org-workforce', navKey: 'workforce', titleNamespace: 'agents', titleKey: 'title' },
];

export interface NavTitleMismatch {
  navItemId: string;
  navValue: string | undefined;
  titleValue: string | undefined;
}

type Messages = Record<string, Record<string, unknown> | undefined>;

export function findNavTitleMismatches(
  messages: Messages,
  pairings: readonly NavTitlePairing[] = NAV_TITLE_PAIRINGS,
): NavTitleMismatch[] {
  const mismatches: NavTitleMismatch[] = [];
  for (const pairing of pairings) {
    const navValue = messages.nav?.[pairing.navKey] as string | undefined;
    const titleValue = messages[pairing.titleNamespace]?.[pairing.titleKey] as string | undefined;
    if (navValue !== titleValue) {
      mismatches.push({ navItemId: pairing.navItemId, navValue, titleValue });
    }
  }
  return mismatches;
}

function main(): void {
  const locales = ['ko', 'en'] as const;
  let failed = false;

  for (const locale of locales) {
    const messages = JSON.parse(readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), 'utf-8')) as Messages;
    const mismatches = findNavTitleMismatches(messages);
    if (mismatches.length === 0) {
      console.log(`OK(${locale}): nav 라벨 ↔ 착지 제목 어긋남 0건(대상 ${NAV_TITLE_PAIRINGS.length}자리).`);
      continue;
    }
    failed = true;
    console.error(`\n❌ FAIL(${locale}): nav 라벨 ↔ 착지 제목 어긋남 ${mismatches.length}건:`);
    for (const m of mismatches) {
      console.error(`  - [${m.navItemId}] nav="${m.navValue}" ↔ title="${m.titleValue}"`);
    }
  }

  if (failed) {
    console.error(
      '\n→ 「같은 화면 두 세계」 — 진입점(nav)과 착지 화면이 다른 낱말을 쓰면 라벨만 보고 들어간 ' +
        '사람이 다른 화면인 줄 헷갈린다. 둘 중 하나를 정본에 맞춰 정정(어느 쪽이 정본인지는 유나 § 확定).',
    );
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
