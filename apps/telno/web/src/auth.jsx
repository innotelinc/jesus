import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

/**
 * Session state, in three flavours rather than two:
 *
 *   ready  a session that can use the console
 *   unpaid a real session whose subscription is not in force — it can see the
 *          plans and buy one, and nothing else
 *   anon   no session
 *
 * Collapsing `unpaid` into `anon` would show a customer the login form while
 * their cookie is perfectly valid, which is how a paying customer concludes the
 * platform is broken.
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null, reason: '' });

  const probe = useCallback(async () => {
    try {
      const data = await api.get('/auth/me');
      setState({ status: 'ready', user: data.user, reason: '' });
      return 'ready';
    } catch (err) {
      if (err.status === 402) {
        try {
          const portal = await api.get('/portal/status');
          setState({ status: 'unpaid', user: portal.user, reason: err.message, portal });
          return 'unpaid';
        } catch {
          setState({ status: 'anon', user: null, reason: '' });
          return 'anon';
        }
      }
      setState({ status: 'anon', user: null, reason: '' });
      return 'anon';
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    api
      .get('/auth/me')
      .then((data) => !canceled && setState({ status: 'ready', user: data.user, reason: '' }))
      .catch(async (err) => {
        if (canceled) return;
        if (err.status === 402) {
          try {
            const portal = await api.get('/portal/status');
            if (!canceled) setState({ status: 'unpaid', user: portal.user, reason: err.message, portal });
            return;
          } catch {
            /* fall through to anon */
          }
        }
        if (!canceled) setState({ status: 'anon', user: null, reason: '' });
      });
    return () => {
      canceled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    setState({ status: 'ready', user: data.user, reason: '' });
    // A customer's access depends on a subscription, and only the paid gate
    // knows. Ask it before deciding which screen the user lands on.
    if (data.user?.kind === 'customer') await probe();
    return data.user;
  }, [probe]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } finally {
      setState({ status: 'anon', user: null, reason: '' });
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      login,
      logout,
      refresh: probe,
      setUser: (user) => setState({ status: 'ready', user, reason: '' }),
    }),
    [state, login, logout, probe]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
