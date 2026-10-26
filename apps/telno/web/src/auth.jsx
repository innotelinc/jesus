import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null });

  useEffect(() => {
    let canceled = false;
    api
      .get('/auth/me')
      .then((data) => !canceled && setState({ status: 'ready', user: data.user }))
      .catch(() => !canceled && setState({ status: 'anon', user: null }));
    return () => {
      canceled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    setState({ status: 'ready', user: data.user });
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } finally {
      setState({ status: 'anon', user: null });
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      login,
      logout,
      setUser: (user) => setState({ status: 'ready', user }),
    }),
    [state, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
