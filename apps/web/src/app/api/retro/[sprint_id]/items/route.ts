const GONE = Response.json({ error: { code: 'GONE', message: 'v1 retro API is removed. Use /api/retro-sessions/:id instead.' } }, { status: 410 });

export async function GET() { return GONE; }
export async function POST() { return GONE; }
export async function PATCH() { return GONE; }
export async function DELETE() { return GONE; }
