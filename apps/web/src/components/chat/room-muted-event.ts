/** story 4946 — the chat list flips a room's mute flag from its row menu; the open room page (beside the list) listens to this and takes the same value, so its «muted» mark and menu never lag behind until a reload */
export const ROOM_MUTED_EVENT = 'sprintable:room-muted';
