import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

/**
 * Session state, in three flavors rather than two:
 *
 *   ready  a session that can use the console
 *   unpaid a real session whose subscription is not in force — it can see the
 *          plans and buy one, and nothing else
 *   anon   no session
 *
 * Collapsing `unpaid` into `anon` would show a customer the login form while
 * their cookie is perfectly valid, which is how a paying customer concludes the
 * platform is broken.
 *
 * Alongside the flavor travels `onboarding`: whether the account has finished
 * the first-login steps, and which one it stopped at. It comes from the same
 * answer as the session, because a screen full of panels that the API then
 * refuses is not what "required" is supposed to look like.
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, reason: '', onboarding: null, portal: null });

  const probe = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setState({ status: 'ready', user: data.user, onboarding: data.onboarding, reason: '', portal: null });
      return 'ready';
    } catch (err) {
      if (err.status === 402) {
        try {
          const portal = await api.get('/portal/status');
          setState({
            status: 'unpaid',
            user: portal.user,
            reason: err.message,
            portal,
            onboarding: portal.onboarding || null,
          });
          return 'unpaid';
        } catch {
          /* fall through to anon */
        }
      }
      setState({ status: 'anon', user: null, reason: '', onboarding: null, portal: null });
      return 'anon';
    }
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  const login = useCallback(
    async (email, password) => {
      const data = await api.post('/auth/login', { email, password });
      setState({ status: 'ready', user: data.user, onboarding: null, reason: '', portal: null });
      // A session that exists is not the same as a session that may use the
      // console: the paid gate and the first-login steps both answer that, and
      // only the server knows. Ask it before deciding which screen to show.
      await probe();
      return data.user;
    },
    [probe]
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } finally {
      setState({ status: 'anon', user: null, reason: '', onboarding: null, portal: null });
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      login,
      logout,
      refresh: probe,
      setUser: (user) => setState((current) => ({ ...current, status: 'ready', user, reason: '' })),
    }),
    [state, login, logout, probe]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
