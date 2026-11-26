// story 5032 (C2) — the list is TWO groups: the projects' channels, and the one-to-one / group rooms. A channel is a room the server marks `is_project_channel` (one per project; the type stays `group` so every
// delivery · permission · list rule that reads dm/group keeps working); everything else, including an older server's rooms (the mark is absent), is a one-to-one / group room and keeps the server's order.
export interface GroupableRoom { is_project_channel?: boolean | null }

export function splitRooms<T extends GroupableRoom>(rooms: readonly T[]): { channels: T[]; rooms: T[] } {
  const channels: T[] = [];
  const others: T[] = [];
  for (const r of rooms) (r.is_project_channel === true ? channels : others).push(r);
  return { channels, rooms: others };
}
