/**
 * Auth service — maps to `/api/auth` on the Express backend.
 *
 * Production flow (backend): bcrypt password hashing, JWT issued on login,
 * token verified by an auth middleware, role checked by an authorize middleware.
 * The demo flow below mimics the same contract in the browser.
 */
import { DEMO_USERS } from "@/lib/demo-data";
import type { User } from "@/types";
import { ApiError, USE_DEMO_DATA, apiRequest, delay, setToken } from "./api-client";

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

export function readSession(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export async function login(input: LoginInput): Promise<AuthResponse> {
  if (!USE_DEMO_DATA) {
    const res = await apiRequest<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
    saveSession(res);
    return res;
  }
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

export async function register(input: RegisterInput): Promise<AuthResponse> {
  if (!USE_DEMO_DATA) {
    const res = await apiRequest<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
    saveSession(res);
    return res;
  }
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

export async function logout(): Promise<void> {
  setToken(null);
  if (typeof window !== "undefined") window.localStorage.removeItem(SESSION_KEY);
}

export async function updateProfile(patch: Partial<Pick<User, "name" | "email">>): Promise<User> {
  const current = readSession();
  if (!current) throw new ApiError("Your session has expired. Please sign in again.", 401);
  if (!USE_DEMO_DATA) return apiRequest<User>("/users/me", { method: "PATCH", body: JSON.stringify(patch) });
  await delay(null, 400);
  const updated = { ...current, ...patch };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(updated));
  return updated;
}
