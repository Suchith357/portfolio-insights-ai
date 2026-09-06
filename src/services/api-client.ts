/**
 * REST client for the PortfolioIQ Express API.
 *
 * The React app NEVER talks to PostgreSQL directly — every read/write goes
 * through this client to `/api/*` on the Node/Express server.
 *
 * While the backend + PostgreSQL schema are being designed, the service modules
 * in this folder resolve against a local demo store (see `demo-store.ts`) and
 * expose exactly the same async signatures, so switching over is a one-line
 * change inside each service.
 */
export const API_BASE_URL: string =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "/api";

export const USE_DEMO_DATA: boolean =
  (import.meta.env["VITE_USE_DEMO_DATA"] as string | undefined) !== "false";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_KEY = "portfolioiq.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

/** Generic JSON request against the Express API. Adds the JWT when present. */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("We couldn't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    // Internal error details are never surfaced to the user.
    const message =
      res.status === 401
        ? "Your session has expired. Please sign in again."
        : res.status === 403
          ? "You don't have access to this resource."
          : res.status === 404
            ? "We couldn't find what you were looking for."
            : "Something went wrong on our end. Please try again.";
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

/** Small latency so loading states are exercised while running on demo data. */
export function delay<T>(value: T, ms = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
