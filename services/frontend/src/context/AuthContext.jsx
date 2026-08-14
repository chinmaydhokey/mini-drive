import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { authAPI, setAccessToken, getAccessToken, clearAccessToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  // Initialize user from localStorage to prevent redirecting to /login on refresh
  const [user, setUser] = useState(() => {
    try {
      const savedUser = localStorage.getItem('minidrive_user');
      return savedUser ? JSON.parse(savedUser) : null;
    } catch {
      return null;
    }
  });

  // If we already have a saved token, don't block the screen with full loading
  const [loading, setLoading] = useState(() => {
    try {
      return !localStorage.getItem('minidrive_access_token');
    } catch {
      return true;
    }
  });

  const initCalled = useRef(false);

  // Re-verify session in background on mount
  useEffect(() => {
    if (initCalled.current) return;
    initCalled.current = true;

    const initAuth = async () => {
      try {
        const storedToken = getAccessToken();
        if (storedToken) {
          try {
            const me = await authAPI.getMe();
            setUser(me.data.data.user);
            try {
              localStorage.setItem('minidrive_user', JSON.stringify(me.data.data.user));
            } catch {}
            setLoading(false);
            return;
          } catch {
            // Stored access token may be expired, attempt refresh below
          }
        }

        // Attempt refresh
        const { data } = await authAPI.refresh();
        setAccessToken(data.data.accessToken);
        const me = await authAPI.getMe();
        setUser(me.data.data.user);
        try {
          localStorage.setItem('minidrive_user', JSON.stringify(me.data.data.user));
        } catch {}
      } catch {
        clearAccessToken();
        try {
          localStorage.removeItem('minidrive_user');
        } catch {}
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
    try {
      localStorage.setItem('minidrive_user', JSON.stringify(data.data.user));
    } catch {}
    return data.data.user;
  }, []);

  const register = useCallback(async (email, username, password) => {
    const { data } = await authAPI.register({ email, username, password });
    setAccessToken(data.data.accessToken);
    setUser(data.data.user);
    try {
      localStorage.setItem('minidrive_user', JSON.stringify(data.data.user));
    } catch {}
    return data.data.user;
  }, []);

  const logout = useCallback(async () => {
    try { await authAPI.logout(); } catch {}
    clearAccessToken();
    try {
      localStorage.removeItem('minidrive_user');
    } catch {}
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
