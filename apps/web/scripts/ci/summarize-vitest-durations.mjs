#!/usr/bin/env node
// ⚠️story #4333 — 아래 «측정치×3»(duration으로 시한을 정하는 관례)은 폐기됐다: 벽시계 예산은 부하 따라 까닭 없이 RED라 시한은 행 가드
// (5초 이상)만 · 일의 양은 결정적으로(scripts/test-utils/fs-work.ts · 가드 no-wallclock-test-budget). 이 스크립트의 표는 느린 테스트를
// 찾는 관측용으로 남는다.
//
// story #3904 — CI vitest 단계가 `pnpm vitest run | tail -80`(기본 리포터)라 개별 테스트
// duration이 로그에 안 남는다(성공 run에서 값을 읽을 수 없다 — story #3902의 「측정치×3」이
// CI 실측 대신 로컬 5회 관측으로 대체된 원인). vitest JSON 리포터(`--reporter=json
// --outputFile.json=<path>`)는 default 리포터와 동시에 켤 수 있어(둘 다 병행 — tail -80
// 계약과 충돌 0, A/B 실측 결과 CI 시간 증가 무시할 수준) 콘솔 출력은 그대로 두고 그 JSON
// 파일만 이 스크립트가 후처리한다.
//
// 두 가지 일을 한다:
//   ① stdout에 «느린 테스트 상위 N» 표를 찍는다(별도 스텝의 로그라 tail -80에 안 잘린다).
//   ② «작게 다듬은» duration 배열(파일 상대경로·테스트명·ms만, vitest 리포터 원본의
//      ancestorTitles·failureMessages·meta·tags·절대경로 등은 버림)을 파일로 써서 GitHub
//      artifact 업로드 대상으로 삼는다 — story #3864(2026-09-14)가 겪은 "매 run always()
//      업로드가 org 단위 artifact 저장 한도를 채운" 실사고(playwright-report, 실측 7,996개·
//      1,719MB)가 바로 이 워크플로 파일 안에 있다. 이 카드(AC2)는 실패 run에서도 남아야
//      하는 게 요건이라(always() 자체는 유지) payload 크기를 줄이는 쪽으로 그 위험을
//      상쇄한다 — GitHub가 artifact를 자체 압축(zip)하는 것과 별개로, 애초에 기록하는
//      필드 수를 원본 리포터 JSON보다 줄여 둔다.
//
// 순수 로직(extractDurationEntries·formatTopTable)과 CLI I/O를 분리한다 — vitest로 순수
// 로직만 픽스처 입력으로 단위 테스트할 수 있게(파일시스템 목업 없이).
//
// 사용법: node scripts/ci/summarize-vitest-durations.mjs <raw-json-path> <summary-out-path> [topN=30]

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * vitest JSON 리포터 원본 결과에서 (file, test, ms) 배열을 뽑아 내림차순 정렬해 낸다.
 * @param {object} raw vitest --reporter=json 출력을 JSON.parse한 객체
 * @param {string} repoRoot 절대경로 → repo-상대경로 변환 기준
 * @returns {{file: string, test: string, ms: number}[]}
 */
export function extractDurationEntries(raw, repoRoot) {
  const entries = [];
  for (const fileResult of raw?.testResults ?? []) {
    const relFile = path.relative(repoRoot, fileResult.name || '');
    for (const assertion of fileResult.assertionResults ?? []) {
      if (typeof assertion.duration !== 'number') continue;
      entries.push({
        file: relFile,
        test: assertion.fullName || assertion.title || '(이름 없음)',
        ms: Math.round(assertion.duration),
      });
    }
  }
  entries.sort((a, b) => b.ms - a.ms);
  return entries;
}

/**
 * 상위 N개를 마크다운 표 문자열로 낸다(로그용).
 * @param {{file: string, test: string, ms: number}[]} entries (내림차순 정렬 가정)
 * @param {number} topN
 * @param {number} totalCount entries가 이미 슬라이스됐을 수 있으므로 "전체 N건" 표기용 원본 건수
 */
export function formatTopTable(entries, topN, totalCount) {
  const top = entries.slice(0, topN);
  const lines = [];
  lines.push(`\n## 느린 테스트 상위 ${top.length}(전체 ${totalCount}건 중, story #3904)\n`);
  lines.push('| ms | file | test |');
  lines.push('|---:|---|---|');
  for (const e of top) {
    lines.push(`| ${e.ms} | ${e.file} | ${e.test.slice(0, 120)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const [, , rawPath, summaryOutPath, topNArg] = argv;
  const topN = Number(topNArg) || 30;

  if (!rawPath || !summaryOutPath) {
    console.error('usage: summarize-vitest-durations.mjs <raw-json-path> <summary-out-path> [topN=30]');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(rawPath, 'utf8'));
  } catch (err) {
    // story #3904 AC3 — 계측 스텝 자체의 실패가 테스트 판정에 영향을 주면 안 된다(무관 PR
    // no-op·exit code 무변 계약). vitest가 JSON을 못 썼거나(예: crash) 파싱이 깨져도 이
    // 스크립트는 경고만 내고 exit 0으로 끝낸다 — 이 스텝이 본 CI 판정을 절대 못 죽인다.
    console.error(`summarize-vitest-durations: ${rawPath} 읽기/파싱 실패(계측 스킵, 판정 무관) — ${err.message}`);
    process.exit(0);
    return;
  }

  const repoRoot = process.env.GITHUB_WORKSPACE || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
  const entries = extractDurationEntries(raw, repoRoot);

  console.log(formatTopTable(entries, topN, entries.length));

  writeFileSync(summaryOutPath, JSON.stringify(entries));
  console.error(`summarize-vitest-durations: ${entries.length}건 요약을 ${summaryOutPath}에 씀`);
}

// ESM 진입점 판별(직접 실행됐을 때만 main() 호출 — import될 때는 안 돎, 테스트 파일이
// 순수 함수만 import해서 쓸 수 있게).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
