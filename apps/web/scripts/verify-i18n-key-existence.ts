/**
 * story #3420(2026-09-04) — 「코드가 가리키는 번역 키가 messages/*.json에 없으면 CI가
 * 빨강」. PR#3768(story #3402)의 api-error.ts::KNOWN_ERRORS가 가리키는 labelKey 6개가
 * messages/ko.json·en.json 어디에도 정의돼 있지 않았는데, develop 머지·dev 배포까지
 * 아무도(tsc·기존 테스트·CI·QA) 못 잡았다 — 해당 코드가 실제로 뜨면 next-intl이
 * MISSING_MESSAGE로 화면을 깼을 것이다.
 *
 * 근본원인 — 이 프로젝트는 next-intl의 공식 타입 증강(`declare module 'next-intl'`류
 * `Messages` 전역선언)을 안 쓴다(그라운딩 확認, ef663fe6 스토리 코멘트). `useTranslations`가
 * 문자열 리터럴로 호출되면 일부 테스트 파일의 `wrap(node, messages: typeof koMessages)`
 * 우연한 구조적 타입비교로 가끔 걸리지만, `t(변수)`(labelKey를 값으로 든 테이블에서 가져온
 * 문자열)로 우회 호출하는 자리는 그 우연한 안전장치의 사정권 밖이다.
 *
 * 이 가드는 그 사각만 좁게 막는다 — "코드에 키를 값으로 든 테이블"(`xxxKey: 'literalKey'`
 * 형태로 선언된 자리)을 정적 스캔해 그 리터럴이 ko.json·en.json 양쪽에 실존하는지 본다.
 * verify-no-i18n-phrase-collision.ts(#2367)와는 다른 축이다 — 그쪽은 "두 번역값이 서로
 * 겹치는지"(내용 축), 이건 "코드가 참조하는 키가 애초에 존재하는지"(존재 축)다. 같은
 * `.test.ts` 관례(grandfather/exempt/양성대조)를 공유하지만 스캔 로직은 독립이다.
 *
 * AC(선언) — 이 가드가 «못 잡는 것» 둘.
 *   ㉠동적 키 조립 — `t(\`prefix_${x}\`)`·객체 스프레드로 조립되는 키 이름은 정규식이 문자열
 *     리터럴을 못 뽑는다(collision 가드 AC4㉡과 같은 한계).
 *   ㉡«키 필드 이름» 자체가 아래 KEY_FIELD_NAMES 목록에 없는 새 테이블 — 새 컴포넌트가
 *     "라벨을 값으로 드는 맵"을 새로 만들면 그 필드 이름을 목록에 추가해야 스캔 대상이 된다
 *     (이름 없는 임의 문자열은 스캔하지 않는다 — 그러면 일반 문자열 리터럴 전부가 오탐이 된다).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenMessages } from './verify-no-i18n-phrase-collision';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../messages');
const EXT_RE = /\.(ts|tsx)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;

// "키를 값으로 드는" 필드 이름. api-error.ts의 KNOWN_ERRORS가 실제로 이 모양이었다
// (`labelKey: 'errorChannelTokenExpired'`) — 새 테이블을 추가하면 그 필드 이름을 여기 넣는다.
const KEY_FIELD_NAMES = ['labelKey'];
const KEY_FIELD_RE = new RegExp(`\\b(?:${KEY_FIELD_NAMES.join('|')}):\\s*'([^']*)'`, 'g');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export interface MissingKeyFinding {
  file: string;
  key: string;
  missingLocales: string[];
}

export interface KeyExistenceScanResult {
  files: string[];
  keysScanned: number;
  findings: MissingKeyFinding[];
}

/** ko.json/en.json을 로드해 "namespace.key" 형태의 flat key Set을 각 locale별로 낸다. */
function loadMessageKeySets(): Record<string, Set<string>> {
  const locales = readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));
  const out: Record<string, Set<string>> = {};
  for (const locale of locales) {
    const parsed = JSON.parse(readFileSync(path.join(MESSAGES_DIR, locale), 'utf8'));
    out[locale] = new Set(flattenMessages(parsed).keys());
  }
  return out;
}

/**
 * KEY_FIELD_NAMES 필드가 리터럴로 드는 번역 키가 모든 locale에 실존하는지 스캔한다. 빈
 * 문자열(`labelKey: ''`)은 "이 코드는 소비부가 직접 문구를 조립한다"는 의도적 표시라
 * 스캔 대상에서 제외한다(api-error.ts의 text_too_long·gate_already_held가 이 모양).
 */
export function scanKeyExistence(): KeyExistenceScanResult {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const keySetsByLocale = loadMessageKeySets();
  const localeNames = Object.keys(keySetsByLocale);

  const findings: MissingKeyFinding[] = [];
  let keysScanned = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = path.relative(SRC_ROOT, file);
    for (const m of content.matchAll(KEY_FIELD_RE)) {
      const key = m[1]!;
      if (key === '') continue; // 의도적 위임(소비부가 문구 직접 조립) — AC 선언 참고
      keysScanned += 1;
      // messages/*.json은 namespace 최상위 키 하나(예: "content")를 wrapper로 두므로,
      // 코드가 드는 키는 namespace 없이 리터럴만 갖는다(예: 'errorChannelTokenExpired').
      // 어느 namespace에 실리는지는 소비부(useTranslations('content') 등)가 정하므로, 이
      // 가드는 "그 리터럴이 어떤 namespace 아래에든 최소 하나는 존재하는지"를 본다 — 정확한
      // namespace까지 좁히려면 useTranslations 호출부를 추적해야 하는데(AC4㉠급 확장) 이
      // 가드의 좁은 스코프 밖이다(선언).
      const missingLocales = localeNames.filter((locale) => {
        const keys = keySetsByLocale[locale]!;
        for (const flatKey of keys) {
          if (flatKey === key || flatKey.endsWith(`.${key}`)) return false;
        }
        return true;
      });
      if (missingLocales.length > 0) {
        findings.push({ file: rel, key, missingLocales });
      }
    }
  }

  return { files, keysScanned, findings };
}

function main(): void {
  const { files, keysScanned, findings } = scanKeyExistence();
  console.log(
    `[story #3420] i18n 키 실존 대조 — 파일 ${files.length}개 · 키 필드(${KEY_FIELD_NAMES.join(',')}) 참조 ${keysScanned}건`,
  );
  if (findings.length === 0) {
    console.log('  누락 없음.');
    return;
  }
  for (const f of findings) {
    console.log(`  ⛔ ${f.file} — 키 '${f.key}'가 ${f.missingLocales.join(', ')}에 없음`);
  }
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
