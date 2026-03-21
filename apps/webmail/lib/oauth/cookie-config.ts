const COOKIE_SAME_SITE = (process.env.COOKIE_SAME_SITE || 'lax') as 'lax' | 'none' | 'strict';

export function getCookieOptions() {
  return {
    httpOnly: true,
    secure: COOKIE_SAME_SITE === 'none' ? true : process.env.NODE_ENV === 'production',
    sameSite: COOKIE_SAME_SITE,
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  };
}
