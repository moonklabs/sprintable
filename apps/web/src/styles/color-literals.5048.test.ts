// story 5048 ③b-3 — 소스에 «색 값 직접»(`#rrggbb` · `#rgb` · `rgb()` · `rgba()` · `hsl()` · `oklch()`)을 새로 쓰지 않는다. 색은 토큰(ds-*)을 거친다.
// 아래 허용 목록은 «토큰 밖이 맞는 곳»만 — 파일 단위 · 개수 정확(늘면 RED — 조용히 못 자람) · 줄마다 사유 한 줄. 이 목록이 자라는 diff는 PO가 본다.
// (주석 속 색 이름 · 스토리 번호 `#0d1c69f3`처럼 16진수 꼴인 것은 세지 않는다 — 코드 줄만, 주석 줄은 건너뜀.)
// 팔레트 색 클래스(`bg-amber-100` …)는 ③b-3에서 상태 틴트(`bg-warning-tint` 등)로 걷었다 — 아래에서 0을 따로 못 박는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const OUT_OF_BOUNDARY = [/^components\/nav\//]; // 민(C1)의 nav/* — 경계(허용 목록이 아니라 경계 제외)

/** 파일 → [정확한 개수, 사유]. 색이 «값 자체가 내용»이거나 토큰을 못 읽는 자리. */
const ALLOWED: Record<string, [number, string]> = {
  'lib/channel-label.ts': [15, '외부 채널(Threads · Instagram …) 상표색 — 우리 토큰이 아니라 그쪽 브랜드 값'],
  'components/ui/label-chip.tsx': [7, '사용자가 고르는 라벨 색 팔레트 — 색 자체가 데이터'],
  'components/docs/lib/mermaid-renderer.ts': [7, 'Mermaid 다이어그램 고정 테마 — 렌더러 내부 설정값(CSS 변수를 못 읽음)'],
  'app/login/page.tsx': [4, 'Google «G» 로고 4색 — 상표 규정 값'],
  'app/register/page.tsx': [4, 'Google «G» 로고 4색 — 상표 규정 값'],
  'app/invite/invite-client.tsx': [4, 'Google «G» 로고 4색 — 상표 규정 값'],
  'services/canvas.ts': [11, '내보내기 독립 HTML 문서의 인라인 스타일 — 앱 밖에서 열려 CSS 변수가 없음'],
  'app/manifest.ts': [2, 'PWA 매니페스트 theme/background — 매니페스트는 CSS 변수를 못 씀'],
  'components/settings/two-factor-section.tsx': [2, '2단계 인증 QR — 스캐너 대비를 위해 흑백 고정(테마와 무관해야 함)'],
  'components/brand/sprintable-logo.tsx': [2, '로고 모노 톤 채움 — 상표 마크 값'],
  'lib/runtime-capabilities.ts': [4, '에이전트 런타임 커넥터 아이콘 대표색 — 외부 제품 상표색'],
};

const HEX = /(?<![&\w#/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])/g;
const FN = /(?<![A-Za-z0-9_-])(?:rgba?|hsla?|oklch|oklab)\(/g;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules' || p === join(SRC, 'styles')) continue; yield* sources(p); continue; }
    if (!/\.tsx?$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

function count(text: string): number {
  // 블록 주석(`/* … */` · JSX `{/* … */}` · 여러 줄 포함)을 통째로 걷고, 줄 끝 `// …` 주석도 걷는다 — 주석 속 스토리 번호 `#4cdad425`는 색이 아니다.
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let n = 0;
  for (const line of noBlock.split('\n')) {
    if (line.trim().startsWith('//')) continue;
    const code = line.replace(/\s\/\/[^'"`]*$/, '');
    n += (code.match(HEX)?.length ?? 0) + (code.match(FN)?.length ?? 0);
  }
  return n;
}

describe('색 값 직접 — 5048 ③b-3', () => {
  const found = new Map<string, number>();
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
    const n = count(readFileSync(file, 'utf8'));
    if (n > 0) found.set(rel, n);
  }

  it('⭐허용 목록 밖에서 색 값을 직접 쓴 곳 0 — 토큰(`ds-*` · `var(--…)`)으로', () => {
    const offenders = [...found].filter(([f]) => !(f in ALLOWED)).map(([f, n]) => `${f}: ${n}`);
    expect(offenders).toEqual([]);
  });

  it('⭐허용 목록 파일은 개수가 정확히 같다 — 늘면 새 색 값이 몰래 들어온 것 · 줄면 목록을 줄일 것', () => {
    const drift = Object.entries(ALLOWED).filter(([f, [n]]) => (found.get(f) ?? 0) !== n).map(([f, [n]]) => `${f}: 등재 ${n} → 실측 ${found.get(f) ?? 0}`);
    expect(drift).toEqual([]);
  });

  it('⭐팔레트 색 클래스(`bg-amber-100` · `text-sky-800` …)는 0 — 상태 틴트 · ds 토큰으로', () => {
    const PALETTE = /(?<![A-Za-z0-9_-])(?:[a-z0-9:-]+:)*(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?(?![A-Za-z0-9_-])/g;
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
      for (const m of readFileSync(file, 'utf8').matchAll(PALETTE)) hits.push(`${rel}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });
});
