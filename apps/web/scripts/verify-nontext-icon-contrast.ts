/**
 * story #4123 AC3(대비 가드 잔여 2, 유나 판별 규칙 정본 artifact f08541fd·PO 확定
 * 2026-09-21) — 비텍스트(currentColor 아이콘) 3:1 판별기.
 *
 * 단일 판별 축(유나 정본, 그대로 코드화) — 그래픽이 상태·동작·정보를 전하는 «유일한
 * 보이는 수단»이면 3:1 대상이다. 같은 뜻을 전하는 «보이는» 텍스트가 곁에 있으면(중복)
 * 제외한다. `aria-hidden`은 판별 축이 아니다(단독 아이콘 버튼은 글리프에 aria-hidden이
 * 붙어도 — 접근명은 버튼 자신의 aria-label이 맡고 — 저시력 사용자에겐 유일한 시각
 * 어포던스라 여전히 3:1 대상이다. `aria-hidden`을 "장식=제외"로 코드화하면 단독 아이콘
 * 버튼 전체가 거짓음성으로 빠진다는 것이 유나 정본의 핵심 경고).
 *
 * 대상 카테고리(코드화, 정적 신호) —
 *  ① 단독 아이콘 버튼 — button/a/[role=button]류의 직계 JSX 자식이 아이콘(svg 태그 또는
 *     PascalCase 컴포넌트) 하나뿐이고, 그 외 «보이는 텍스트» 형제(JsxText 단어·다른 JSX
 *     표현식 자식)가 없다. 접지: chat-input.tsx:890(Paperclip, aria-label만).
 *  ② 상태 단독 그래픽 — 상태색(FAMILIES) 배경/글자 클래스를 쓰는 작은 장식 요소가 같은
 *     부모 안에 보이는 텍스트 형제 없이 홀로 선다(예: 아바타 위 온라인 dot). 유나 접지
 *     표의 실사용 예(team-presence-panel.tsx)는 실은 인접 텍스트가 있어 «제외»로
 *     실측됐다 — 지금 레포엔 ②의 실 인스턴스가 0건이다(로직은 남겨둔다, 미래 재발 방지).
 *  ③ 폼 컨트롤(checkbox/radio) — PO 확定(2026-09-21 19:36Z, #4123 카드 논의) — 색 원천이
 *     ①②(currentColor+우리 토큰)와 다르다: 브라우저 네이티브 accent-color 기본값은 우리
 *     토큰 시스템 밖이라 정적 CSS 대조로 잴 방법이 없다. 그래서 이 축은 **존재-검사만**
 *     — 명시적 색 override(className의 `accent-*`, 또는 인라인 `style={{ accentColor }}`)
 *     가 있을 때만 그 값을 3:1로 검사한다. override가 없으면(네이티브 기본) 스킵 —
 *     "체크박스가 없어서 0건"이 아니라 "override가 없어 실측 불가라서 0건"이다.
 *     (발견·카드 밖: 체크박스가 토큰 시스템 밖이라는 사실 자체는 accent-color 토큰화
 *     여부를 정할 유나 canon 후보로 별도 이월 — globals.css 변경이라 이 카드 경계 밖.)
 *
 * 제외(코드화 안 함 — 대상으로 안 잡음, 별도 "제외 규칙"이 불요) — 인접 보이는 텍스트가
 * 있는 아이콘·순수 장식·비활성·브랜드 로고. 판별 축이 "보이는 텍스트 인접" 하나뿐이므로
 * 그 신호가 있으면 애초에 ①·②의 대상 정의 자체를 만족하지 못해 자연 배제된다(별도
 * "제외 룰" 코드가 없다 — 이게 유나 정본의 "단일 축" 설계 의도 그대로).
 *
 * 이 가드가 못 잡는 것(선언, AC4류 원칙) —
 *   1) ②(상태 단독 그래픽)는 지금 레포에 실 인스턴스 0건 — baseline이 0인 것은 "코드가
 *      없다"가 아니라 "지금 그 모양의 요소가 없다"는 뜻(향후 생기면 자동으로 잡힌다).
 *   2) ①의 "다른 보이는 텍스트 없음" 판정은 인터랙티브 요소의 직계 JSX 자식만 본다 —
 *      더 깊이 중첩된 래퍼(`<button><span><Icon/></span></button>`) 안의 형제 텍스트는
 *      놓칠 수 있다(과소 신뢰 방향 — #2590 자매 가드의 hasDirectText와 같은 한계급).
 *   3) 아이콘 자체의 색은 className의 "항상 적용되는" 문자열 조합만 본다(자매 가드
 *      verify-cross-element-tint-text.ts의 classStringsFromExpr과 동형 — cn()·삼항 양쪽
 *      다 모으되 `&&` 조건부는 "항상 보장 안 됨"이라 제외, 같은 정밀 원칙).
 *   4) 배경은 (a) 같은 요소에 명시된 `bg-*` 클래스가 있으면 그 값, 없으면 (b) 전역
 *      `--background`(페이지 기본)로 근사한다 — 카드·패널 같은 커스텀 배경을 가진 조상은
 *      컴포넌트 경계를 넘으면 원리적으로 못 본다(자매 가드 cross-element와 같은 한계,
 *      "다른 파일이라 원리적 불가" 그대로).
 *   5) split-literal(`cn('text-x', cond && 'text-y')`처럼 색이 여러 리터럴로 쪼개진 경우)
 *      은 "항상 적용되는" 판정이 놓칠 수 있다(자매 가드들과 같은 알려진 간극).
 *
 * 잔여 오탐의 밸브 = `// tint-guard-ok: <이유>`(이유 필수·grep 가능) — 자매 가드
 * verify-cross-element-tint-text.ts와 동일 관례(이 파일은 아이콘류라 위반 줄이 JSX
 * 여는 태그이므로, 그 태그가 시작하는 줄에 같은 관례로 붙인다).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseOklchToRgba, compositeOver } from '../src/lib/oklch-contrast';
import { contrastRatio } from '../src/lib/color-contrast';
import { extractCssVarBlock, resolveCssVarValue, deriveCrossCheckTextVars } from './verify-tint-foreground-contrast';

const GLOBALS_CSS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app/globals.css');
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const AA_NONTEXT_THRESHOLD = 3.0;

const INTERACTIVE_TAGS = new Set(['button', 'a']);

function rgbOf(vars: Map<string, string>, varName: string): [number, number, number] | null {
  const raw = vars.get(varName);
  if (!raw) return null;
  const resolved = resolveCssVarValue(vars, raw);
  const parsed = parseOklchToRgba(resolved);
  if (!parsed) return null;
  return [parsed.r, parsed.g, parsed.b];
}

/** JSX className 초기자에서 «항상 적용되는» 클래스 문자열들을 뽑는다 — 자매 가드
 * verify-cross-element-tint-text.ts::classStringsFromExpr을 본떴으되(발명 0), 그 함수엔
 * 없던 처리 하나를 더한다: 템플릿 리터럴의 `${...}` 보간식 안에 «삼항이 직접 들어간»
 * 경우(예: `` `... ${cond ? 'bg-info/10 text-info' : 'text-muted-foreground'}` ``, 접지
 * chat-input.tsx:890 실사고 재현) — 원본은 `sp.literal.text`(보간식 뒤에 남는 정적
 * 문자열)만 보고 `sp.expression`(보간식 자체) 재귀를 안 해서, 이런 자리의 클래스가
 * «항상 적용되는» 판정에서 통째로 빠진다(빈 문자열만 모임). 각 span의 expression도
 * classStringsFromExpr로 재귀해 합친다 — 삼항 양쪽 다 «둘 중 하나는 항상 적용»이므로
 * 그대로 정밀 원칙과 정합. ⚠️이 파일이 고친 이 보간식-삼항 재귀 누락은
 * verify-cross-element-tint-text.ts에도 그대로 남아있다(동형 함수, 동형 버그) — #4123
 * 카드 밖(다른 파일)이라 이 스토리에서 고치지 않고 발견만 보고한다(디디, 2026-09-21). */
function classStringsFromExpr(e: ts.Expression): string[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    const parts = [e.head.text, ...e.templateSpans.map((sp) => sp.literal.text)];
    const interpolated = e.templateSpans.flatMap((sp) => classStringsFromExpr(sp.expression));
    return [parts.join(' '), ...interpolated];
  }
  if (ts.isCallExpression(e) && /(?:^|\.)cn$/.test(e.expression.getText())) {
    return e.arguments.flatMap((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? [a.text] : classStringsFromExpr(a)));
  }
  if (ts.isConditionalExpression(e)) {
    return [...classStringsFromExpr(e.whenTrue), ...classStringsFromExpr(e.whenFalse)];
  }
  return [];
}

function classNameStringsOf(opening: ts.JsxOpeningLikeElement): string[] {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'className' && a.initializer) {
      if (ts.isStringLiteral(a.initializer)) return [a.initializer.text];
      if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return classStringsFromExpr(a.initializer.expression);
    }
  }
  return [];
}

function tagNameOf(opening: ts.JsxOpeningLikeElement): string {
  return opening.tagName.getText();
}

function hasRoleButton(opening: ts.JsxOpeningLikeElement): boolean {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'role' && a.initializer) {
      if (ts.isStringLiteral(a.initializer) && a.initializer.text === 'button') return true;
    }
  }
  return false;
}

/** 접지 실사고(chat-input.tsx:890) — 태그명이 `button`이 아니라 Radix류 커스텀 트리거
 * 컴포넌트(`DropdownMenuTrigger` 등, PascalCase)이지만 `type="button"` 속성을 그대로
 * 갖는다(네이티브 button과 같은 계약). 태그명만 보면 이런 래퍼를 전부 놓친다 — 이
 * 코드베이스가 실제로 Radix Trigger류에 `type="button"`을 다는 관례를 그대로 신호로
 * 쓴다(발명 0, 실측 패턴 재사용). */
function hasButtonTypeAttr(opening: ts.JsxOpeningLikeElement): boolean {
  for (const a of opening.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'type' && a.initializer) {
      if (ts.isStringLiteral(a.initializer) && a.initializer.text === 'button') return true;
    }
  }
  return false;
}

function isInteractiveTag(opening: ts.JsxOpeningLikeElement): boolean {
  return INTERACTIVE_TAGS.has(tagNameOf(opening)) || hasRoleButton(opening) || hasButtonTypeAttr(opening);
}

function isIconTag(tag: string): boolean {
  return tag === 'svg' || /^[A-Z]/.test(tag);
}

/** node 자신이 «보이는 텍스트를 담는» 노드인가 — JsxText(단어 포함)·JsxExpression(`{t(...)}`
 * 등)은 직접, JsxElement(`<h3>작업 중</h3>`류)는 그 직계 자식에 같은 판정을 한 단계 재귀한다
 * (접지 team-presence-panel.tsx:152→153 실사고 재현 — dot 형제가 <h3> «요소»고 그 안에
 * 글자가 있다, dot과 같은 레벨에 맨 텍스트가 아니다). */
function isVisibleTextNode(c: ts.Node): boolean {
  if (ts.isJsxText(c)) return /[\w가-힣]/.test(c.text);
  if (ts.isJsxExpression(c)) return !!c.expression;
  if (ts.isJsxElement(c)) return c.children.some((cc) => isVisibleTextNode(cc));
  return false;
}

function hasOtherVisibleTextChild(children: ts.NodeArray<ts.JsxChild>, iconChild: ts.Node): boolean {
  return children.some((c) => c !== iconChild && isVisibleTextNode(c));
}

export type NonTextIconCategory = 'standalone-icon-button' | 'standalone-status-graphic' | 'form-control-accent-override';

/** `null` = 명시적 bg 없음(전역 --background로 근사). `{varName, alphaPct: null}` = 불투명
 * 토큰 그대로 — varName은 실제로 lookup할 CSS 변수명이다(«-tint/-bg 접미가 붙으면 그
 * 자체가 별도 변수»라는 게 이 필드를 둔 이유: `bg-destructive-tint`는 `--destructive`가
 * 아니라 `--destructive-tint`(pale 별개 값)를 봐야 한다 — 접지 story-detail-panel.tsx:1816
 * 실사고에서 이 둘을 같은 변수로 착각해 자기-대조(ratio=1.0) 거짓 FAIL이 났다).
 * `{varName, alphaPct: N}` = `bg-family/N`(알파 유틸, varName=family 자체의 불투명 값을
 * N%로 페이지 배경에 합성) — 접지 chat-input.tsx:890(`bg-info/10`)이 이 축. 알파는 반드시
 * 합성 후 재야 한다(compositeOver, verify-tint-foreground-contrast.ts와 동형 원칙). */
export interface ExplicitBg {
  varName: string;
  alphaPct: number | null;
}

export interface IconContrastCandidate {
  file: string;
  line: number;
  category: NonTextIconCategory;
  tag: string;
  textColorVar: string | null;
  bgVar: ExplicitBg | 'background';
}

const STATUS_DOT_BG_RE = /(?<![\w-])bg-([\w]+)(?![\w/-])/;
const ROUNDED_FULL_RE = /(?<![\w-])rounded-full(?![\w-])/;

export function findExplicitBgVar(cls: string, statusColorNames: readonly string[]): ExplicitBg | null {
  for (const name of statusColorNames) {
    const suffixed = new RegExp(`(?<![\\w-])bg-${name}(-bg|-tint)(?![\\w-])`).exec(cls);
    if (suffixed) return { varName: `${name}${suffixed[1]}`, alphaPct: null };
    const alpha = new RegExp(`(?<![\\w-])bg-${name}/(\\d+)(?![\\w-])`).exec(cls);
    if (alpha) return { varName: name, alphaPct: Number(alpha[1]) };
    const bare = new RegExp(`(?<![\\w-])bg-${name}(?![\\w/-])`).exec(cls);
    if (bare) return { varName: name, alphaPct: null };
  }
  return null;
}

function findTextColorVar(cls: string, statusColorNames: readonly string[]): string | null {
  for (const name of statusColorNames) {
    if (new RegExp(`(?<![\\w-])text-${name}(?![\\w-])`).test(cls) && !new RegExp(`text-${name}-foreground`).test(cls)) return name;
  }
  return null;
}

/** 폼 컨트롤(#3) 존재-검사 축 — Tailwind의 `accent-*` 유틸(accent-color CSS 프로퍼티)이
 * 명시적으로 있을 때만 그 값을 잰다. 없으면(className에 accent- 접두 클래스가 전혀 없음)
 * 브라우저 네이티브 기본값이라 이 함수가 null을 반환 — 호출부가 candidate 자체를 안 만든다. */
function findAccentColorOverride(cls: string, statusColorNames: readonly string[]): string | null {
  for (const name of statusColorNames) {
    if (new RegExp(`(?<![\\w-])accent-${name}(?![\\w-])`).test(cls)) return name;
  }
  return null;
}

/** #1(단독 아이콘 버튼)·#2(상태 단독 그래픽) 후보를 AST에서 찾는다. 폼 컨트롤(#3)은
 * 별도 checkInputAccentOverrides가 담당(성질이 달라 같은 walk에 안 섞는다). */
export function scanContent(content: string, file: string, statusColorNames: readonly string[]): IconContrastCandidate[] {
  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const { withReason } = suppressWindows(content);
  const candidates: IconContrastCandidate[] = [];

  function walk(node: ts.Node): void {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      if (isInteractiveTag(opening)) {
        const iconChildren = node.children.filter((c) => {
          if (ts.isJsxElement(c)) return isIconTag(tagNameOf(c.openingElement));
          if (ts.isJsxSelfClosingElement(c)) return isIconTag(tagNameOf(c));
          return false;
        });
        if (iconChildren.length === 1) {
          const iconChild = iconChildren[0]!;
          const iconOpening = ts.isJsxElement(iconChild) ? iconChild.openingElement : (iconChild as ts.JsxSelfClosingElement);
          const iconHasOwnText = ts.isJsxElement(iconChild) && iconChild.children.some((cc) => ts.isJsxText(cc) && /[\w가-힣]/.test(cc.text));
          if (!iconHasOwnText && !hasOtherVisibleTextChild(node.children, iconChild)) {
            const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
            if (!withReason.has(line)) {
              // 접지 실사고(chat-input.tsx:890) — 아이콘 자신은 색 클래스가 없고
              // (`h-4 w-4`뿐) `currentColor`로 부모(버튼/트리거)의 `text-*`를 상속한다.
              // 아이콘 자신의 className을 먼저 보되, 없으면 컨테이너(버튼)의 className도
              // 본다(실 상속 경로 그대로 — 지어낸 축 아님).
              const iconCls = classNameStringsOf(iconOpening).join(' ');
              const containerCls = classNameStringsOf(opening).join(' ');
              const textColorVar = findTextColorVar(iconCls, statusColorNames) ?? findTextColorVar(containerCls, statusColorNames);
              candidates.push({
                file, line, category: 'standalone-icon-button', tag: tagNameOf(iconOpening),
                textColorVar, bgVar: findExplicitBgVar(classNameStringsOf(opening).join(' '), statusColorNames) ?? 'background',
              });
            }
          }
        }
      }
    }

    // 상태 단독 그래픽(#2) — rounded-full + 상태색 solid bg를 가진 leaf(자식 없음/self-closing),
    // 같은 부모 안 형제에 보이는 텍스트가 없을 때.
    let selfClosingOpening: ts.JsxOpeningLikeElement | null = null;
    if (ts.isJsxSelfClosingElement(node)) selfClosingOpening = node;
    else if (ts.isJsxElement(node) && node.children.length === 0) selfClosingOpening = node.openingElement;
    if (selfClosingOpening) {
      const cls = classNameStringsOf(selfClosingOpening).join(' ');
      if (ROUNDED_FULL_RE.test(cls)) {
        const m = STATUS_DOT_BG_RE.exec(cls);
        const bgFamily = m ? m[1]! : null;
        if (bgFamily && statusColorNames.includes(bgFamily) && !/-tint|-bg|\//.test(cls.slice(cls.indexOf(`bg-${bgFamily}`)))) {
          const parent = node.parent;
          const siblings = ts.isJsxElement(parent) ? parent.children : null;
          const hasSiblingText = siblings ? hasOtherVisibleTextChild(siblings, node) : false;
          if (!hasSiblingText) {
            const line = sf.getLineAndCharacterOfPosition(selfClosingOpening.getStart(sf)).line + 1;
            if (!withReason.has(line)) {
              candidates.push({ file, line, category: 'standalone-status-graphic', tag: tagNameOf(selfClosingOpening), textColorVar: bgFamily, bgVar: 'background' });
            }
          }
        }
      }
    }

    // 폼 컨트롤(#3, PO 확定 2026-09-21 19:36Z) — 존재-검사 축만. checkbox/radio 자체는
    // 브라우저 네이티브 accent-color 기본값(우리 토큰 밖)이라 override가 없으면 스캔
    // 대상에서 빠진다(생성 자체를 안 함 — «0건»이 "검사했는데 통과"가 아니라 "잴 수
    // 없어 안 함"이라는 걸 candidates에 아예 안 넣는 것으로 표현).
    if (ts.isJsxSelfClosingElement(node) && tagNameOf(node) === 'input') {
      const isCheckboxOrRadio = node.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText() === 'type' && a.initializer
          && ts.isStringLiteral(a.initializer) && (a.initializer.text === 'checkbox' || a.initializer.text === 'radio'),
      );
      if (isCheckboxOrRadio) {
        const cls = classNameStringsOf(node).join(' ');
        const accentColorVar = findAccentColorOverride(cls, statusColorNames);
        if (accentColorVar) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (!withReason.has(line)) {
            candidates.push({ file, line, category: 'form-control-accent-override', tag: 'input', textColorVar: accentColorVar, bgVar: 'background' });
          }
        }
        // override 없음 = 네이티브 기본색 = 정적 대조 불가 → candidate 자체를 안 만든다.
      }
    }

    node.forEachChild(walk);
  }
  walk(sf);
  return candidates;
}

/** 자매 가드 verify-cross-element-tint-text.ts와 동일 escape-valve 관례 —
 * `// tint-guard-ok: <이유>`가 붙은 줄(과 바로 다음 줄)은 통과시키되, 이유 없는 억제는
 * 없다(이유 필수 · grep 가능 · 안 썩게). */
function suppressWindows(content: string): { withReason: Set<number> } {
  const lines = content.split('\n');
  const withReason = new Set<number>();
  for (let i = 0; i < lines.length; i += 1) {
    if (/\/\/\s*tint-guard-ok:\s*\S/.test(lines[i]!)) {
      withReason.add(i + 1);
      withReason.add(i + 2);
    }
  }
  return { withReason };
}

export interface Violation {
  file: string;
  line: number;
  category: NonTextIconCategory;
  ratio: number;
}

export function violationKey(v: Pick<Violation, 'file' | 'category'>): string {
  return `${v.file}::${v.category}`;
}

/** 후보의 배경을 최종 RGB로 해석한다 — 불투명 토큰(-bg/-tint·순수 bg-family)은 그 값
 * 그대로, 알파 유틸(`bg-family/N`)은 페이지 배경 위에 N%로 합성한 결과(compositeOver,
 * verify-tint-foreground-contrast.ts와 같은 원칙: «옅은 배경을 불투명 색으로 착각해
 * 자기-대조를 내지 않는다» — chat-input.tsx:890 접지가 정확히 이 함정이었다). */
function resolveBgRgb(bgVar: ExplicitBg | 'background', vars: Map<string, string>, pageBgRgb: [number, number, number]): [number, number, number] | null {
  if (bgVar === 'background') return pageBgRgb;
  const varRgb = rgbOf(vars, bgVar.varName);
  if (!varRgb) return null;
  if (bgVar.alphaPct === null) return varRgb;
  return compositeOver({ r: varRgb[0], g: varRgb[1], b: varRgb[2], a: bgVar.alphaPct / 100 }, pageBgRgb);
}

export function computeViolations(candidates: IconContrastCandidate[], vars: Map<string, string>): Violation[] {
  const pageBgRgb = rgbOf(vars, 'background');
  if (!pageBgRgb) return [];
  const violations: Violation[] = [];
  for (const c of candidates) {
    // 색 지정이 아예 없으면(currentColor가 muted-foreground류 기본을 상속) 이 스캐너의
    // 대상 밖 — 상태색 클래스가 명시된 자리만 잰다(한계 선언 ③과 동형: 색 원천이 우리
    // 토큰인 경우만 정적으로 잴 수 있다).
    if (!c.textColorVar) continue;
    const bg = resolveBgRgb(c.bgVar, vars, pageBgRgb);
    const fg = rgbOf(vars, c.textColorVar);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < AA_NONTEXT_THRESHOLD) {
      violations.push({ file: c.file, line: c.line, category: c.category, ratio });
    }
  }
  return violations;
}

const EXT_RE = /\.tsx$/;
const TEST_RE = /\.test\.tsx$/;
const MIN_EXPECTED_FILES = 300;

function walkDir(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkDir(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepo(srcRoot: string, statusColorNames: readonly string[]): IconContrastCandidate[] {
  const files: string[] = [];
  walkDir(srcRoot, files);
  if (files.length < MIN_EXPECTED_FILES) {
    throw new Error(`FAIL: 검사 대상 파일이 ${files.length}개뿐(srcRoot=${srcRoot}) — 가드가 헛돌고 있다.`);
  }
  const candidates: IconContrastCandidate[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    candidates.push(...scanContent(content, rel, statusColorNames));
  }
  return candidates;
}

const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'nontext-icon-contrast-baseline.json');

export function loadBaseline(filePath: string): Set<string> {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { keys: string[] };
    return new Set(parsed.keys);
  } catch {
    return new Set();
  }
}

function main(): number {
  const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
  const { vars } = extractCssVarBlock(css, ':root');
  const statusColorNames = deriveCrossCheckTextVars(vars);

  const candidates = scanRepo(SRC_ROOT, statusColorNames);
  const violations = computeViolations(candidates, vars);
  const baseline = loadBaseline(BASELINE_PATH);

  const newViolations = violations.filter((v) => !baseline.has(violationKey(v)));
  const grandfathered = violations.filter((v) => baseline.has(violationKey(v)));

  console.log(
    `[story #4123 AC3] 비텍스트(아이콘) 3:1 판별 — 후보 ${candidates.length}건(단독 버튼 ` +
      `${candidates.filter((c) => c.category === 'standalone-icon-button').length}·상태그래픽 ` +
      `${candidates.filter((c) => c.category === 'standalone-status-graphic').length}·폼 컨트롤(accent override 있음) ` +
      `${candidates.filter((c) => c.category === 'form-control-accent-override').length}) · ` +
      `대비 계산 가능(상태색 명시) ${candidates.filter((c) => c.textColorVar).length}건`,
  );
  console.log(`grandfathered baseline: ${baseline.size}건`);
  console.log(`검출 ${violations.length}건(baseline 기존 ${grandfathered.length}건 + 신규 ${newViolations.length}건)`);

  if (newViolations.length > 0) {
    console.error('\nFAIL: baseline에 없는 새 비텍스트 3:1 미달 자리 발견(story #4123 AC3):');
    for (const v of newViolations) {
      console.error(`  ${v.file}:${v.line} [${v.category}] ratio=${v.ratio.toFixed(2)}`);
    }
    console.error(
      '\n의미 있는 그래픽(단독 아이콘 버튼·상태 그래픽)은 인접 색과 3:1 이상이어야 한다(WCAG 1.4.11). ' +
        '정말 예외라면 그 줄에 `// tint-guard-ok: <이유>`를 남기거나 PO 승인을 받는다.',
    );
    return 1;
  }

  console.log('\nOK: 새 비텍스트 3:1 미달 자리 0건(baseline 초과 없음).');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--write-baseline')) {
    const css = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const { vars } = extractCssVarBlock(css, ':root');
    const statusColorNames = deriveCrossCheckTextVars(vars);
    const candidates = scanRepo(SRC_ROOT, statusColorNames);
    const violations = computeViolations(candidates, vars);
    const keys = [...new Set(violations.map(violationKey))].sort();
    process.stdout.write(JSON.stringify({ _comment: [], keys }, null, 2) + '\n');
  } else {
    process.exit(main());
  }
}
