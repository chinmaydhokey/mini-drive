import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authAPI, setAccessToken, clearAccessToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const initCalled = useRef(false);

  // Try to restore session on mount (via stored access token or refresh token cookie)
  useEffect(() => {
    if (initCalled.current) return; // Guard against StrictMode double-mount
    initCalled.current = true;

    const initAuth = async () => {
      try {
        // 1. If we have a stored access token, try getMe() directly
        const storedToken = getAccessToken();
        if (storedToken) {
          try {
            const me = await authAPI.getMe();
            setUser(me.data.data.user);
            setLoading(false);
            return;
          } catch {
            // Access token might be expired, proceed to refresh
          }
        }

        // 2. Try to refresh access token using cookie / endpoint
        const { data } = await authAPI.refresh();
        setAccessToken(data.data.accessToken);
        const me = await authAPI.getMe();
        setUser(me.data.data.user);
      } catch {
        clearAccessToken();
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    initAuth();
  }, []);

  const login = useCallback(async (email, password) => {
    const { data } = await authAPI.login({ email, password });
    setAccessToken(data.data.accessToken);
    setUser(data.data.user);
    return data.data.user;
  }, []);

  const register = useCallback(async (email, username, password) => {
    const { data } = await authAPI.register({ email, username, password });
    setAccessToken(data.data.accessToken);
    setUser(data.data.user);
    return data.data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await authAPI.logout(); } catch {}
    clearAccessToken();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
};
