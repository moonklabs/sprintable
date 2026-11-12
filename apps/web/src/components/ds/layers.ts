/**
 * UI-3(a9d56577) · 4906 — «화면 층 규칙»: 한 화면의 면은 다섯 층이고, 이웃한 두 층은 눈으로 갈려야 한다(바탕과 글 줄이 같은 색이면 어디까지가 글인지 안 보인다 — 선생님 지적 11-12).
 * 층마다 쓰는 토큰은 여기 하나뿐이다(동기화하지 않고 단일화): 화면 코드는 아래 이름을 그대로 쓰고, `styles/layer-rule.test.ts`가 이 토큰들의 실제 값(라이트 · 다크)으로 층 사이 밝기차(OKLab L)를 계산해 지킨다.
 *
 *   층            토큰                  이웃과의 차이(라이트 / 다크)                       지키는 선
 *   바탕           ds-background          —
 *   내용 칸        ds-surface             바탕 → 내용 칸      +0.030 / +0.037                ≥ 0.03
 *   남의 글 줄     ds-surface-high        내용 칸 → 글 줄     −0.052 / +0.059                ≥ 0.05 — 에이전트 글도 같은 층(맨글로 바탕 위에 서지 않는다)
 *   내 글 줄       ds-mine                내용 칸 → 글 줄     −0.114 / +0.124                ≥ 0.09 · 남의 글과 밝기차 0.062 / 0.065(≥ 0.05) + 채도차 0.043 / 0.050(≥ 0.03)
 *   입력칸         ds-surface-sunk        내용 칸 → 입력칸    −0.064 / −0.062                ≥ 0.05 (+ line-control 경계)
 *   떠 있는 것     ds-surface-raised      면 차이로 가르지 않는다 — 그림자(shadow-ds-popup / overlay) + line-control 경계로 가른다
 * 라이트는 «내용 칸이 바탕보다 밝고 글 줄 · 입력칸이 어둡게 들어가는» 꼴, 다크는 «글 줄이 올라오고 입력칸이 들어가는» 꼴이다 — 부호가 달라도 차이의 크기가 선을 지킨다.
 * Tailwind가 클래스를 알아보게 문자열을 통째로 둔다.
 */
export const LAYER = {
  page: 'bg-ds-background',
  panel: 'bg-ds-surface',
  rowOthers: 'bg-ds-surface-high',
  rowMine: 'bg-ds-mine',
  field: 'bg-ds-surface-sunk',
  floating: 'bg-ds-surface-raised',
} as const;

/** 층 → 그 층이 쓰는 토큰 이름(`--ds-*`의 뒷부분). 시험이 값을 읽는 길. */
export const LAYER_TOKEN = {
  page: 'background',
  panel: 'surface',
  rowOthers: 'surface-high',
  rowMine: 'mine',
  field: 'surface-sunk',
  floating: 'surface-raised',
} as const satisfies Record<keyof typeof LAYER, string>;

/** 이웃한 두 층 사이 밝기차(OKLab L)의 최소 크기. */
export const LAYER_MIN_STEP = {
  panelOverPage: 0.03,
  rowOthersOnPanel: 0.05,
  rowMineOnPanel: 0.09,
  /** 내 글과 남의 글 사이: 밝기차(OKLab L)와 채도차(OKLab C) — 연보라와 연회색이 나란히 서면 색조만으로는 안 갈린다(PO 11-12). */
  mineVsOthersLightness: 0.05,
  mineVsOthersChroma: 0.03,
  fieldOnPanel: 0.05,
} as const;
