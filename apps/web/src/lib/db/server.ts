import { cookies } from 'next/headers';
import { jwtVerify } from 'jose';

export const SP_AT_COOKIE = 'sp_at';
export const SP_RT_COOKIE = 'sp_rt';

export interface ServerSession {
  user_id: string;
  email: string;
  access_token: string;
}

function getJwtSecretBytes(): Uint8Array {
  const secret = process.env['JWT_SECRET'] ?? '';
  return new TextEncoder().encode(secret);
}

export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SP_AT_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getJwtSecretBytes());
    if (payload['type'] !== 'access' || !payload.sub) return null;
    return { user_id: payload.sub, email: (payload['email'] as string) ?? '', access_token: token };
  } catch {
    return null;
  }
}
