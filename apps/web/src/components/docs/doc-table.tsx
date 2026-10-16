import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * story 4707 (Yuna AC0 · 선생님 폰 지적) — 문서 표의 «정의 하나». 전체 보기(doc-content-renderer)와 챗 미리보기(embed-card MdBody ·
 * 둘째 렌더러)가 같은 것을 쓴다: 규칙(테두리 · 칸 여백 · 머리 음영) · 감싸개(가로 스크롤 상자) · 폰에서 넓은 표의 카드 꼴.
 * 셋째 사본을 만들지 않는다 — 챗 쪽에 표 처리기가 0이었던 것이 «표 칸이 서로 붙고 문서 전체가 옆으로 밀리는» 뿌리였다.
 */

/** 표 규칙 — 전체 보기의 뿌리 클래스 목록과 챗 미리보기 본문 감싸개가 같은 줄을 쓴다(글 크기는 각 본문이 정한다). */
export const DOC_TABLE_RULES = [
  '[&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-xl [&_table]:border [&_table]:border-border [&_table]:bg-muted/20',
  '[&_thead]:bg-muted/50 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
].join(' ');

/**
 * 폰(< 640px)에서 한글은 낱말 단위로만 끊는다(음절 단위로 쪼개지 않는다) — 표만 가로로 스크롤된다.
 * 칸마다 최소 폭(7rem · AC0 초안)은 뺐다: 실제 Chrome 390px 측정에서 3열 표의 «#» · «누가» 같은 짧은 칸이 112px씩 먹어 긴 칸이
 * 132px로 눌렸고(5행 표 648px → 1303px) 3 × 7rem이 폰 폭 안이라 스크롤도 만들지 못했다. 넓은 표(4열 이상)는 카드가 맡는다.
 */
const PHONE_SCROLL_RULES = 'max-sm:[&_td]:[word-break:keep-all] max-sm:[&_th]:[word-break:keep-all]';

/** 폰에서 이 열 수 이상인 표는 행마다 카드로 그린다(Yuna AC0 ②) — 그보다 좁은 표는 표 그대로 가로 스크롤. */
export const PHONE_CARD_MIN_COLUMNS = 4;

/** 표를 감싼 칸의 폭이 이 값(px) 미만이면 4열 이상 표는 카드 — 화면 폭이 아니라 칸 폭 기준(컨테이너 쿼리) */
export const CARD_BELOW_PX = 640;

type TableCell = ReactNode;

function elementsOf(node: ReactNode, tags: readonly string[]): ReactElement<{ children?: ReactNode }>[] {
  const out: ReactElement<{ children?: ReactNode }>[] = [];
  Children.forEach(node, (child) => {
    if (isValidElement(child) && typeof child.type === 'string' && tags.includes(child.type)) out.push(child as ReactElement<{ children?: ReactNode }>);
  });
  return out;
}

/** react-markdown이 `table`에 넘긴 자식(thead · tbody · tr · th · td 요소)에서 머리와 행의 칸 내용을 읽는다. 머리가 없으면 null. */
export function readDocTable(children: ReactNode): { headers: TableCell[]; rows: TableCell[][] } | null {
  let headers: TableCell[] = [];
  const rows: TableCell[][] = [];
  for (const section of elementsOf(children, ['thead', 'tbody'])) {
    for (const tr of elementsOf(section.props.children, ['tr'])) {
      const cells = elementsOf(tr.props.children, ['th', 'td']).map((cell) => cell.props.children as TableCell);
      if (section.type === 'thead' && headers.length === 0) headers = cells;
      else rows.push(cells);
    }
  }
  return headers.length > 0 ? { headers, rows } : null;
}

const hasContent = (cell: TableCell): boolean => Children.toArray(cell).some((x) => typeof x !== 'string' || x.trim() !== '');

/** 표 감싸개 — 코드블럭과 같은 성격(가로로 잘린 열이 있다는 것을 알린다 · story 2165). */
const SCROLL_SHELL = 'not-prose overflow-x-auto scrollbar-visible rounded-xl border border-border';

/** html 문서(sanitize 뒤)의 표도 같은 가로 스크롤 상자에 담는다 — 마크다운 경로와 같은 모양. */
export function wrapTablesInScrollShell(html: string): string {
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (tableMarkup) => `<div class="${SCROLL_SHELL} ${PHONE_SCROLL_RULES}">${tableMarkup}</div>`);
}

/**
 * 마크다운 `table` 처리기. `phoneCards`(챗 미리보기만 켠다): 머리 열이 PHONE_CARD_MIN_COLUMNS 이상이면 «표를 감싼 칸의 실제 폭»이
 * CARD_BELOW_PX 미만일 때 행마다 카드(«머리: 값» 줄 — 빈 칸은 줄이 없다)를 그리고, 그 이상이면 표를 그린다. 카드는 같은 칸 내용(링크 ·
 * 코드 · 강조)을 그대로 다시 쓴다.
 *
 * 기준이 화면(뷰포트) 폭이 아니라 그 칸의 폭인 까닭(story 4707 다시 열림 · 선생님 지적 10-16): 넓은 화면의 옆 문서 칸(약 480~720px)은 화면
 * 폭으로는 «폰이 아닌데» 표가 한 열 두세 글자로 짓눌린다. CSS 컨테이너 쿼리(`@container` + `@min-[…]`)로 칸 폭을 보므로 폰(칸 < 640) ·
 * 좁은 옆 칸 모두 카드, 넓은 칸만 표. 컨테이너 쿼리를 모르는 낡은 웹뷰는 `@min` 규칙을 못 읽어 카드(안전한 쪽)로 남는다.
 */
export function DocTable({ children, phoneCards = false }: { children?: ReactNode; phoneCards?: boolean }) {
  const scroll = (
    <div className={`${SCROLL_SHELL} ${PHONE_SCROLL_RULES}`} data-doc-table="">
      <table>{children}</table>
    </div>
  );
  const data = phoneCards ? readDocTable(children) : null;
  if (!data || data.headers.length < PHONE_CARD_MIN_COLUMNS) return scroll;
  return (
    <div className="@container" data-doc-table-box="">
      <div className="hidden @min-[640px]:block">{scroll}</div>
      <ul className="not-prose m-0 mb-2 flex list-none flex-col gap-3 p-0 @min-[640px]:hidden" data-doc-table-cards="">
        {data.rows.map((cells, i) => (
          <li key={i} className={cn(cardVariants({ surface: 'subtle', radius: 'compact' }), 'flex flex-col gap-1 p-3')} data-doc-table-card="">
            {cells.map((cell, j) => (hasContent(cell) ? (
              <p key={j} className="text-sm leading-6 [overflow-wrap:anywhere]">
                {data.headers[j] !== undefined && hasContent(data.headers[j]) ? <><span className="font-semibold">{data.headers[j]}</span>{': '}</> : null}
                {cell}
              </p>
            ) : null))}
          </li>
        ))}
      </ul>
    </div>
  );
}
