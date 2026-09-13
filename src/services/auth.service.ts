/**
 * Auth service — maps to `/api/auth` and `/api/users/me` on the Express backend.
 *
 * Session rules:
 *  - The stored session is a JWT + cached user profile. On startup the token
 *    is verified against the backend (`GET /api/auth/me`) before the session
 *    is trusted — a stale/localStorage-forged profile can never auto-login.
 *  - Logout always clears the token, including server-side awareness by
 *    simply discarding it (JWTs are stateless; invalidation on password
 *    change is enforced by the backend via `password_changed_at`).
 *  - No automatic demo login happens in API mode.
 */
import { DEMO_USERS } from "@/lib/demo-data";
import type { User } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, delay, getToken, setToken } from "./api-client";

const SESSION_KEY = "portfolioiq.session";

export interface AuthResponse {
  token: string;
  user: User;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
}

function saveSession(res: AuthResponse) {
  setToken(res.token);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(res.user));
  }
}

function clearSession() {
  setToken(null);
  if (typeof window !== "undefined") window.localStorage.removeItem(SESSION_KEY);
}

/**
 * Reads the cached session profile. The returned value is a *hint* only —
 * `validateSession` must succeed before the UI treats the user as signed in.
 */
export function readSession(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a stored session against the backend. Returns the verified user,
 * or null when there is no session or the token is invalid/expired/revoked.
 * Any 401 clears the local session so the next paint shows the login page.
 */
export async function validateSession(): Promise<User | null> {
  if (USE_DEMO_DATA) {
    return readSession();
  }
  if (!getToken()) return null;
  try {
    const user = await apiRequest<User>("/auth/me");
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    }
    return user;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearSession();
    }
    return null;
  }
}

export async function login(input: LoginInput): Promise<AuthResponse> {
  if (USE_DEMO_DATA) {
    await delay(null, 500);
    const match = DEMO_USERS.find(
      (u) => u.email.toLowerCase() === input.email.trim().toLowerCase() && u.password === input.password,
    );
    if (!match) throw new ApiError("Email or password is incorrect.", 401);
    const { password: _password, ...user } = match;
    const res = { token: `demo.${user.id}.token`, user };
    saveSession(res);
    return res;
  }
  const res = await apiRequest<AuthResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
  });
  saveSession(res);
  return res;
}

export async function register(input: RegisterInput): Promise<AuthResponse> {
  if (USE_DEMO_DATA) {
    await delay(null, 600);
    if (DEMO_USERS.some((u) => u.email.toLowerCase() === input.email.trim().toLowerCase())) {
      throw new ApiError("An account with this email already exists.", 409);
    }
    const user: User = {
      id: `usr_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim(),
      email: input.email.trim().toLowerCase(),
      role: "USER",
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    };
    const res = { token: `demo.${user.id}.token`, user };
    saveSession(res);
    return res;
  }
  const res = await apiRequest<AuthResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
  });
  saveSession(res);
  return res;
}

export async function logout(): Promise<void> {
  clearSession();
}

export async function updateProfile(patch: Partial<Pick<User, "name" | "email">>): Promise<User> {
  if (USE_DEMO_DATA) {
    const current = readSession();
    if (!current) throw new ApiError("Your session has expired. Please sign in again.", 401);
    await delay(null, 400);
    const updated = { ...current, ...patch };
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
    return updated;
  }
  const updated = await apiRequest<User>("/users/me", { method: "PATCH", body: JSON.stringify(patch) });
  // Keep the cached session user in sync with the server response.
  if (typeof window !== "undefined") {
    const current = readSession();
    if (current) {
      window.localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ ...current, ...updated, token: undefined }),
      );
    }
  }
  return updated;
}

/**
 * Changes the password via the backend. The backend invalidates every JWT
 * issued before this moment, so the current session is intentionally ended —
 * the caller should route the user back to login.
 */
export async function changePassword(currentPassword: string, newPassword: Promise<string> | string): Promise<{ changed: true }> {
  if (USE_DEMO_DATA) {
    await delay(null, 400);
    return { changed: true };
  }
  const password = await newPassword;
  return apiRequest<{ changed: true }>("/users/me/password", {
    method: "PATCH",
    body: JSON.stringify({ currentPassword, newPassword: password }),
  });
}
