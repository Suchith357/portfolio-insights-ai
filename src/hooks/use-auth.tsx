import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { User } from "@/types";
import * as authService from "@/services/auth.service";

interface AuthContextValue {
  user: User | null;
  /** True once the initial session validation has completed. */
  ready: boolean;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  updateProfile: (patch: Partial<Pick<User, "name" | "email">>) => Promise<User>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Startup session validation: a stored token is only trusted after the
      // backend confirms it. Invalid/expired tokens land on the login page.
      const verified = await authService.validateSession();
      if (!cancelled) {
        setUser(verified);
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authService.login({ email, password });
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const res = await authService.register({ name, email, password });
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
  }, []);

  const updateProfile = useCallback(async (patch: Partial<Pick<User, "name" | "email">>) => {
    const updated = await authService.updateProfile(patch);
    setUser(updated);
    return updated;
  }, []);

  const value = useMemo(
    () => ({ user, ready, isAdmin: user?.role === "ADMIN", login, register, logout, updateProfile }),
    [user, ready, login, register, logout, updateProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
