import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  clearSession,
  isExpired,
  loadSession,
  saveSession,
  setUnauthorizedHandler,
} from "@/lib/api/session";
import type { IssuedSession, Permission } from "@/lib/api/types";

interface AuthValue {
  session: IssuedSession | null;
  isAuthenticated: boolean;
  /** §8.1.5 gating, so the UI does not offer an act the server will refuse. */
  can: (permission: Permission) => boolean;
  signIn: (session: IssuedSession) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

function initialSession(): IssuedSession | null {
  const session = loadSession();
  if (session !== null && isExpired(session)) {
    clearSession();
    return null;
  }
  return session;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<IssuedSession | null>(initialSession);

  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback((next: IssuedSession) => {
    saveSession(next);
    setSession(next);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // best effort — the local session goes either way
    }
    clearSession();
    setSession(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      session,
      isAuthenticated: session !== null,
      can: (permission) => session?.account.permissions.includes(permission) ?? false,
      signIn,
      signOut,
    }),
    [session, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within an AuthProvider");
  return value;
}
