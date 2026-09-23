import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * story #4197 — 채팅 말풍선 본문에서 내부 HTML 주석(`<!-- linear-comment-id … -->` 등 외부 동기화가 심는 비가시
 * 마커)만 걷어내는 remark 플러그인. 원문을 정규식으로 자르지 않고 **마크다운 AST에서 html 노드만** 다룬다 —
 * 코드(펜스 3·4백틱·`~~~`·들여쓰기·인라인 다중 백틱)·인용·목록은 파서가 이미 정확히 갈라 두므로 그 안의 리터럴
 * `<!--`는 html 노드가 아니라 건드리지 않는다(원문 정규식 방식은 까디르 반례에서 뒷본문 통째 삭제·코드 틀 소실을 냈다).
 *
 * - html 노드: 값에서 주석 부분만 지운다. 남는 게 공백뿐이면 노드째 없앤다(`<!-- s --> **TAIL**`처럼 한 노드에
 *   주석+뒷글이면 뒷글은 남긴다). 닫히지 않은 `<!--`는 그 html 노드의 끝까지 주석으로 본다 — CommonMark가
 *   그 블록을 컨테이너(인용·목록 항목) 안에서 끝내므로 바깥 문단은 안 지워진다.
 * - 그 결과 텍스트가 없어진 문단은 없앤다(빈 줄이 남지 않게). 주석이 빠진 자리의 앞뒤 공백은 하나로 합친다.
 */
type MdNode = { type: string; value?: string; children?: MdNode[] };

const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

function isBlankPhrasing(node: MdNode): boolean {
  return (node.type === 'text' && !(node.value ?? '').trim()) || node.type === 'break';
}

function strip(node: MdNode): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === 'html') {
      const value = (child.value ?? '').replace(COMMENT_RE, '');
      if (value.trim()) next.push({ ...child, value });
      continue;
    }
    if (child.type === 'text' && (child.value ?? '').includes('<!--')) {
      // 닫히지 않은 인라인 `<!--`는 html 노드가 아니라 글자로 남는다 — 그 글자 노드 안에서만 끝까지 주석으로 본다
      // (코드는 text 노드가 아니라 안 건드린다·다른 문단엔 번지지 않는다).
      const value = (child.value ?? '').replace(/<!--[\s\S]*$/, '');
      if (value) next.push({ ...child, value });
      continue;
    }
    strip(child);
    if (child.type === 'paragraph' && (child.children ?? []).every(isBlankPhrasing)) continue;
    next.push(child);
  }
  // 줄 가운데 주석이 빠진 자리: 앞 텍스트 끝 공백 + 뒤 텍스트 앞 공백이 겹치면 하나로.
  for (let i = 0; i + 1 < next.length; i++) {
    const a = next[i]!, b = next[i + 1]!;
    if (a.type === 'text' && b.type === 'text' && /[ \t]$/.test(a.value ?? '') && /^[ \t]/.test(b.value ?? '')) {
      b.value = (b.value ?? '').replace(/^[ \t]+/, '');
    }
  }
  node.children = next;
}

export function remarkStripHtmlComments() {
  return (tree: MdNode) => { strip(tree); };
}

/**
 * 본문에 보일 것이 남는지(«표시할 내용이 없는 메시지» 판정용). 렌더러와 **같은 파서**(remark-parse + gfm +
 * remarkStripHtmlComments)를 돌린 AST에 노드가 하나도 안 남을 때만 «비었다» — 코드 노드는 내용이 주석 모양이어도
 * 보이는 것이다. 문자열 규칙으로 파서를 흉내 내면 틈이 생긴다(PR #4559 까디르: 주석 뒤 들여쓰기 줄을 렌더러는
 * 코드로 그리는데 문자열 판정은 «주석만»이라 보이는 코드를 가렸다). 평문 경로도 주석만이면 같은 결론이다.
 */
const emptinessProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkStripHtmlComments);

export function isCommentOnlyContent(content: string): boolean {
  if (!content.includes('<!--')) return false;
  const tree = emptinessProcessor.runSync(emptinessProcessor.parse(content)) as MdNode;
  return (tree.children ?? []).length === 0;
}

/**
 * 마크다운 문법이 전혀 없는(평문 경로 — whitespace-pre-wrap) 본문에서 주석을 줄 단위로 걷는다. 코드·인용·목록 문법이
 * 없을 때만 쓰므로(호출부가 판정) 원문 정규식이 코드를 해칠 자리가 없다. 유나 design: 주석을 뺀 같은 메시지와 줄 수가
 * 같아야 한다 — 주석만 있던 줄은 줄바꿈까지, 줄 머리·꼬리는 곁 공백까지, 줄 가운데는 공백 하나, 앞뒤 빈 줄은 걷는다.
 */
export function stripHtmlCommentsFromPlainText(content: string): string {
  const out = content.replace(
    /[ \t]*<!--[\s\S]*?(?:-->|$)[ \t]*(\r?\n)?/g,
    (match: string, newline: string | undefined, offset: number, whole: string) => {
      const atLineStart = offset === 0 || whole[offset - 1] === '\n';
      const atLineEnd = newline !== undefined || offset + match.length === whole.length;
      if (atLineStart) return '';
      if (atLineEnd) return newline ?? '';
      return ' ';
    },
  );
  return out.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}
