/**
 * 4908 — 보드 카드 사이 방향키 초점 이동(끌고 있지 않을 때). 카드(`[data-story-card]`)와 열(`[data-board-column]`)의 DOM 순서가 곧 화면 순서다:
 * ↑↓ = 같은 열의 이웃 카드 · ←→ = 이웃 열(카드가 하나도 없는 열 · 띠는 건너뜀)의 같은 자리(그 열이 더 짧으면 마지막) 카드.
 * 옮겨 간 카드가 화면 밖이면 가장 가까운 자리로 스크롤한다. 이동했으면 true.
 */
export function moveCardFocus(card: HTMLElement, key: string): boolean {
  const column = card.closest<HTMLElement>('[data-board-column]');
  if (!column) return false;
  const cardsOf = (col: Element) => [...col.querySelectorAll<HTMLElement>('[data-story-card]')];
  const cards = cardsOf(column);
  const index = cards.indexOf(card);
  if (index < 0) return false;

  let target: HTMLElement | undefined;
  if (key === 'ArrowUp') target = cards[index - 1];
  else if (key === 'ArrowDown') target = cards[index + 1];
  else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    let sibling = key === 'ArrowLeft' ? column.previousElementSibling : column.nextElementSibling;
    while (sibling) {
      if (sibling.matches('[data-board-column]')) {
        const there = cardsOf(sibling);
        if (there.length > 0) { target = there[Math.min(index, there.length - 1)]; break; }
      }
      sibling = key === 'ArrowLeft' ? sibling.previousElementSibling : sibling.nextElementSibling;
    }
  }
  if (!target) return false;
  target.focus();
  target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}
