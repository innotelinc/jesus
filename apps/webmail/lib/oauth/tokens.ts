export const OAUTH_SCOPES = 'openid email profile';
export const REFRESH_TOKEN_COOKIE = 'jmap_rt';

/** Get the cookie name for a given account slot (0-4). Slot 0 uses the legacy name. */
export function refreshTokenCookieName(slot: number): string {
  return slot === 0 ? REFRESH_TOKEN_COOKIE : `${REFRESH_TOKEN_COOKIE}_${slot}`;
}
