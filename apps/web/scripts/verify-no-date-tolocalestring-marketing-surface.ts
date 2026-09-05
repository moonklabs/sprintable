/**
 * story #3486(3436 묶음 8 잔여, 유나 10회차 관찰 2026-09-05) — 「연결 시각」이
 * `new Date(...).toLocaleString()`(브라우저 로케일 의존)으로 남아 있던 자리를
 * 묶음 8 정본(`formatRelativeTime`, PR #3814)으로 정정한 뒤, 같은 결함이 이
 * 표면(마케팅 콘텐츠·채널 연결)에 다시 새지 않게 가드한다.
 *
 * ⚠️PO 정정(2026-09-05) — 원래 AC2는 "apps/web/src 안 toLocaleString( 호출 0"으로
 * 하우스 전체를 가리키는 것처럼 읽혔으나, 유나 10회차의 「하우스」는 묶음 8이 다룬
 * 마케팅 표면 하나를 가리킨 것이었다(오기). 아래 네 디렉터리 밖(문서·칸반·활동
 * 로그·설정·인박스·리워드 등 20+곳)은 각자 다른 기능 영역이라 이 스토리 범위
 * 밖이다 — 그 목록은 PR 본문에 "범위 밖·미착수"로 남긴다(후속 스토리 여부는 PO
 * 별도 판단).
 *
 * 가드 범위(마케팅운영 콘텐츠·채널 연결 표면만):
 *   - app/(authenticated)/content/**
 *   - app/(authenticated)/organization/channels/**
 *   - components/content/**
 *   - components/channel-connect/**
 *
 * ⛔이 가드가 못 보는 것(선언) — ①위 네 디렉터리 밖의 모든 파일(하우스 전체
 * 20+곳, 스코프 밖) ②숫자 포맷 `.toLocaleString('ko-KR')`류(날짜가 아니다 —
 * 이 가드는 `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString` 어떤
 * 호출이든 이 네 디렉터리 안에서는 전부 날짜 포맷으로 간주해 막는다. 이 범위
 * 안에 지금 숫자 포맷 소비처가 없다는 것을 이 스토리 작성 시점 grep으로 확認
 * 했다 — 나중에 정말 숫자 포맷이 필요해지면 이 가드에 예외를 등재할 것) ③주석·
 * 문자열 리터럴 안의 언급(테스트 파일은 이미 제외).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

const SCOPED_DIRS = [
  'app/(authenticated)/content',
  'app/(authenticated)/organization/channels',
  'components/content',
  'components/channel-connect',
];

const LOCALE_DATE_CALL_RE = /\.(toLocaleString|toLocaleDateString|toLocaleTimeString)\(/g;

export interface DateToLocaleStringHit {
  file: string;
  line: number;
}

export function extractHits(content: string, file: string): DateToLocaleStringHit[] {
  const hits: DateToLocaleStringHit[] = [];
  const lines = content.split('\n');
  lines.forEach((lineText, i) => {
    LOCALE_DATE_CALL_RE.lastIndex = 0;
    if (LOCALE_DATE_CALL_RE.test(lineText)) hits.push({ file, line: i + 1 });
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

function main(): number {
  const files: string[] = [];
  for (const dir of SCOPED_DIRS) {
    const abs = path.join(SRC_ROOT, dir);
    try {
      walk(abs, files);
    } catch {
      // 디렉터리 자체가 없으면(개편 등) 스킵 — 있는 범위만 검사.
    }
  }

  const hits: DateToLocaleStringHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    hits.push(...extractHits(content, rel));
  }

  if (hits.length > 0) {
    console.log(`\n❌ 마케팅 콘텐츠·채널 연결 표면에 날짜 toLocaleString류 ${hits.length}건(story #3486 재발 — formatRelativeTime/formatScheduledAt 정본을 쓸 것):`);
    for (const h of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`  - ${h.file}:${h.line}`);
    }
    return 1;
  }

  console.log('OK: 마케팅 콘텐츠·채널 연결 표면(content/**·organization/channels/**·components/content/**·components/channel-connect/**) 안 날짜 toLocaleString류 0건');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
