// story 4930 — «옛 파랑 강조색이 새 보라 옆에 남음» 가드. 강조 · 활성 · 안 읽음 색은 ds action 한 벌이다.
// ds 의미색 --info(정보 · 상태 · 진행)는 그대로 파랑 — 이 시험은 «강조 · 안 읽음 · 활성으로 쓴 자리»에 info · 옛 brand 파랑이 없음을 못 박는다. 되돌리면(그 자리를 text-proof-blue · bg-info · border-info로) 빨개진다.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('강조 자리에 옛 파랑(info · proof-blue)이 없다 — 4930 AC3', () => {
  it('사이드바 «대화» 줄은 ds action 글자(text-ds-action-text)이고 text-proof-blue · text-info · bg-info가 없다', () => {
    const code = strip(read('components/nav/app-sidebar.tsx'));
    expect(code).toContain('text-ds-action-text');
    expect(code).not.toMatch(/text-proof-blue|text-info\b|bg-info\b|border-info\b|bg-proof-blue\b|border-proof-blue\b/);
  });

  it('받은함: 안 읽음 막대 둘 · 묶음 개수 알약은 ds action(안 읽음 = CountBadge unread의 action) — bg-info · border-info가 없다', () => {
    const code = strip(read('app/(authenticated)/inbox/page.tsx'));
    expect(code.match(/absolute left-0 top-0 h-full w-0\.5 bg-ds-action/g)?.length).toBe(2);
    expect(code).toContain('border-ds-action/30 bg-ds-action/10');
    expect(code).not.toMatch(/\bbg-info\b|border-info\/|\bborder-info\b|\bbg-info\//);
  });

  it('대화 목록 «에이전트» 표는 공용 부품 AgentIdentity다 — 손으로 복사한 틴트 칩(info든 ds action이든)이 없다(방 안 말풍선 · 받은함 · 참여자 창과 한 꼴)', () => {
    const code = strip(read('components/chat/chat-list-view.tsx'));
    expect(code).toMatch(/import \{ AgentIdentity \} from '@\/components\/ui\/agent-identity';/);
    expect(code).toMatch(/\{isAgentInConv && <AgentIdentity\b/);
    expect(code).not.toMatch(/border-(info|ds-action)\/30 bg-(info|ds-action)\/12/);
  });

  it('«에이전트» 표를 그리는 다섯 곳(목록 · 말풍선 · 받은함 · 참여자 창 · 새 대화 창)이 모두 같은 AgentIdentity를 쓴다', () => {
    for (const f of ['components/chat/chat-list-view.tsx', 'components/chat/chat-bubble.tsx', 'app/(authenticated)/inbox/page.tsx', 'components/chat/add-participant-modal.tsx', 'components/chat/new-conversation-modal.tsx']) {
      expect(strip(read(f)), f).toMatch(/import \{(?:[^}](?!\bas\s+AgentIdentity\b))*?\bAgentIdentity\b[^}]*\} from '@\/components\/ui\/agent-identity'/); // a rename (`X as AgentIdentity`) is not the part
    }
  });

  it('ds 안 읽음 규칙: CountBadge unread = bg-ds-action (받은함 막대 · 사이드바 알약이 따르는 기준)', () => {
    expect(read('components/ds/count-badge.tsx')).toContain("unread: 'bg-ds-action text-ds-on-action'");
  });
});

describe('--brand 소비처 — 로고 · 상표 표시는 ds 별칭 밖(PO 조건 가)', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(tsx|ts)$/.test(n) && !/\.(test|spec)\./.test(n)) out.push(p);
    }
    return out;
  };
  it('SprintableLogo 를 쓰는 어느 파일도 그 className 에 text-brand · bg-brand(별칭이 된 색)를 주지 않는다 — 워드마크 색은 text-brand-wordmark(옛 값 그대로)', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/<SprintableLogo[\s\S]*?\/>/g)) if (/\b(text|bg|fill|stroke)-brand\b(?!-)/.test(m[0])) offenders.push(f.replace(SRC, ''));
    }
    expect(offenders).toEqual([]);
    expect(strip(read('app/login/page.tsx'))).toContain('text-brand-wordmark dark:text-foreground');
  });

  it('워드마크 토큰은 옛 brand 파랑 값 그대로(상표 색 불변)이고 마크 색(--brand-mark-*)도 그대로다', () => {
    const css = read('app/globals.css');
    expect(css).toMatch(/--brand-wordmark:\s*oklch\(0\.56 0\.17 254\)/);
    expect(css).toMatch(/--brand-mark-primary:\s*#42549B/);
    expect(css).toMatch(/--brand-mark-accent:\s*#00A3D1/);
    expect(css).toContain('--color-brand-wordmark: var(--brand-wordmark);');
  });

  it('globals.css 에 에디터 강조(링크 · 선택 · 인용 줄)도 옛 파랑 리터럴이 아니라 ds action 이다', () => {
    const css = strip(read('app/globals.css'));
    for (const name of ['--tiptap-link', '--tiptap-selection', '--tiptap-blockquote-border']) {
      const vals = [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))].map((m) => m[1]!.trim());
      expect(vals.length, name).toBe(2);
      for (const v of vals) expect(v, name).toMatch(/^var\(--ds-action(-text)?\)$/);
    }
  });

  it('옛 파랑 oklch 리터럴(색상 245~275° · 채도 0.03↑)은 globals.css 에 --brand-wordmark · 사람 구분 색판(--role-accent-1 · 정보 위 글 --info-foreground)뿐이다', () => {
    const css = strip(read('app/globals.css'));
    const names = [...css.matchAll(/(--[\w-]+)\s*:\s*oklch\(\s*[\d.]+\s+([\d.]+)\s+(2[4-7]\d(?:\.\d+)?)\s*\)/g)].filter((m) => Number(m[2]) >= 0.03).map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(['--brand-wordmark', '--info-foreground', '--role-accent-1']);
  });

  it('(존재 확인) 이 가드가 읽는 파일이 실제로 있다', () => {
    for (const f of ['components/nav/app-sidebar.tsx', 'app/(authenticated)/inbox/page.tsx', 'components/chat/chat-list-view.tsx', 'components/ds/count-badge.tsx', 'app/login/page.tsx', 'app/globals.css']) expect(existsSync(join(SRC, f)), f).toBe(true);
  });
});
