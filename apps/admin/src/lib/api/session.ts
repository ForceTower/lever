import type { IssuedSession } from "@/lib/api/types";

const KEY = "lever.session";

function isSession(value: unknown): value is IssuedSession {
  if (typeof value !== "object" || value === null) return false;
  return (
    "token" in value &&
    typeof value.token === "string" &&
    "expiresAt" in value &&
    typeof value.expiresAt === "number" &&
    "account" in value &&
    typeof value.account === "object" &&
    value.account !== null
  );
}

export function loadSession(): IssuedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(session: IssuedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // private-mode storage failures are not worth failing a login over
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Sessions do not slide (§8.1.4): once the stamp passes, only a new login helps. */
export function isExpired(session: IssuedSession): boolean {
  return session.expiresAt <= Date.now();
}

// Lets the transport tell React that the server rejected the token mid-use, so
// the provider can drop the session and fall back to the sign-in screen.
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}
