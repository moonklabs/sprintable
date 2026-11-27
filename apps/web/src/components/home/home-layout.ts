// story 5031 (C1 step 5c · PO ii) — the home's two-column rule, as NAMED numbers in one place. The detail column is a fixed 340, the grid gap is 16 (`lg:gap-4` of ListDetailShell), and the list is never narrower than 360 (what it always was at its narrowest).
// So the two columns exist only when the BODY has really received 340 + 16 + 360 = 716: below that the detail is the bottom sheet and the list takes the whole body. The decision is made from the width the body actually got (not from a number of the window,
// which would hide the chrome's own widths: the icon bar 56, the list column 256, the body padding 48 …) — hooks/use-detail-beside-list.ts reads it.
// (list-detail-shell.tsx writes `340px` as a class literal — Tailwind reads classes from the text; list-detail-shell.test.tsx ties that literal to HOME_DETAIL_W.)
export const HOME_DETAIL_W = 340;
export const HOME_GAP = 16;
export const HOME_LIST_MIN = 360;
export const HOME_TWO_COLUMN_MIN = HOME_DETAIL_W + HOME_GAP + HOME_LIST_MIN; // 716
