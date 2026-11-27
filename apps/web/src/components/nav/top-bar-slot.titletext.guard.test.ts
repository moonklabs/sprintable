// story 5031 (C1 step 5a · codex round 1) — a screen that puts a COMPONENT into the top bar's title slot must also say the title's plain words (`titleText`), or use `TitleTopBarSlot` (which does). Why: the desktop bar's path ends with the title and drops the
// place's name when the title already says it; the words of a component are not in the element (`<AgentsTopBarTitle />` has no text node), so a publisher that forgets read as «no title» and the place was said twice («조직 › 에이전트 › 에이전트»).
// Parsed with TypeScript (JSX props can hold `/>` and nested elements — a regex cannot walk them). A title that is a plain element (`<h1>{t('x')}</h1>`, `<span>…</span>`) needs nothing: its text is read from the element.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
/** publishers whose component / variable title is deliberately not given words, with the reason (a new line needs a reason) */
const EXEMPT: Record<string, string> = {
  'app/(authenticated)/chats/[conversation_id]/page.tsx#RoomBarTitle': 'the phone\'s room bar (below lg only: the path is lg-up); the lg-up room name is a span with titleText',
  'components/agents/agent-run-detail.tsx#titleEl': 'a memoised <h1> whose only child is one string — the element\'s own text is read',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) { if (name !== 'node_modules') walk(f, out); } else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(f);
  }
  return out;
}

function scanText(code: string): string[] {
  const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bad: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(sf) === 'TopBarSlot') {
      const props = new Map(node.attributes.properties.filter(ts.isJsxAttribute).map((a) => [a.name.getText(sf), a]));
      const title = props.get('title')?.initializer;
      const expr = title && ts.isJsxExpression(title) ? title.expression : undefined;
      if (expr && !props.has('titleText')) {
        const el = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
        if (ts.isJsxSelfClosingElement(el) || ts.isJsxElement(el)) {
          const tag = ts.isJsxElement(el) ? el.openingElement.tagName.getText(sf) : el.tagName.getText(sf);
          if (/^[A-Z]/.test(tag)) bad.push(tag); // a component
        } else if (ts.isIdentifier(expr)) bad.push(expr.getText(sf)); // a variable: its words are unknown here
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bad;
}
const slotsWithoutTitleText = (file: string) => scanText(readFileSync(file, 'utf8'));

describe('every <TopBarSlot title={component}> passes titleText (or is a named exemption)', () => {
  const files = walk(SRC).filter((f) => !f.endsWith(`${path.sep}top-bar-slot.tsx`));
  it('self-test: the scanner sees a component or variable title without titleText; a plain element, a titleText-carrying one and the TitleTopBarSlot pass', () => {
    expect(scanText('const a = <TopBarSlot title={<AgentsTopBarTitle />} showContextChip />;')).toEqual(['AgentsTopBarTitle']);
    expect(scanText('const a = <TopBarSlot title={titleEl} actions={<B />} />;')).toEqual(['titleEl']);
    expect(scanText('const a = <TopBarSlot title={<AgentsTopBarTitle />} titleText="x" />;')).toEqual([]);
    expect(scanText('const a = <TopBarSlot title={<h1 className="a">{t("x")}</h1>} actions={<B />} />;')).toEqual([]);
    expect(scanText('const a = <TitleTopBarSlot title={<AgentsTopBarTitle />} useText={useAgentsTopBarTitleText} />;')).toEqual([]);
  });

  it('⭐no publisher in src hands the slot a component (or a variable) title without titleText — outside the named exemptions', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f).split(path.sep).join('/');
      for (const tag of slotsWithoutTitleText(f)) if (!EXEMPT[`${rel}#${tag}`]) offenders.push(`${rel} → ${tag}`);
    }
    expect(offenders, 'use <TitleTopBarSlot title=… useText=…/> (components/nav/flat-tab-top-bar.tsx) or pass titleText').toEqual([]);
  });

  it('every exemption still exists (a stale exemption is removed)', () => {
    const live = new Set<string>();
    for (const f of files) { const rel = path.relative(SRC, f).split(path.sep).join('/'); for (const tag of slotsWithoutTitleText(f)) live.add(`${rel}#${tag}`); }
    expect(Object.keys(EXEMPT).filter((k) => !live.has(k))).toEqual([]);
  });
});
