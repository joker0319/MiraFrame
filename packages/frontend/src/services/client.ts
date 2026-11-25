/**
 * Core API client - fetchApi, static URL resolution, and API object re-exports.
 */
import { ApiError } from "./errors";

// ---------------------------------------------------------------------------
// Backend base URL resolution (mirrors old project's runtimeBase pattern)
// ---------------------------------------------------------------------------
const DEV_BACKEND_PORT = "3000";

export interface ApiBaseEnv {
  VITE_API_URL?: string;
  DEV?: boolean;
}

/**
 * 纯解析函数：环境与 location 由调用方注入，API 与 WS 共用同一套规则。
 * 抽出来的主要目的是让「HTTPS 同源」这类部署形态能被直接测试。
 */
export function resolveApiBase(
  location: { href: string; origin: string } | undefined,
  env: ApiBaseEnv,
): string {
  // 1. 显式配置优先
  if (env.VITE_API_URL) return env.VITE_API_URL;

  if (location) {
    // 2. 开发环境：页面同源换成后端端口
    if (env.DEV) {
      const url = new URL(location.href);
      return `${url.protocol}//${url.hostname}:${DEV_BACKEND_PORT}`;
    }
    // 3. 生产环境：完全同源，走 nginx 的 /api/ 与 /ws/
    return location.origin;
  }

  // 4. SSR / 无 window
  return `http://localhost:${DEV_BACKEND_PORT}`;
}

export function getApiBase(): string {
  let env: ApiBaseEnv = {};
  try {
    if (typeof import.meta !== "undefined") {
      env = {
        VITE_API_URL: (import.meta as any).env?.VITE_API_URL as string | undefined,
        DEV: ((import.meta as any)?.env?.DEV ?? false) as boolean,
      };
    }
  } catch { /* SSR / non-Vite */ }

  return resolveApiBase(
    typeof window === "undefined" ? undefined : window.location,
    env,
  );
}

// Resolve once at module load
const API_BASE = getApiBase();
const ADMIN_TOKEN_STORAGE_KEY = "miraframe_admin_token";
const LEGACY_ADMIN_TOKEN_STORAGE_KEY = "openoii_admin_token";

// ---------------------------------------------------------------------------
// getStaticUrl - safely convert relative /static/... paths to full URLs
// ---------------------------------------------------------------------------
export function getStaticUrl(path: string | null | undefined): string | null {
  if (!path) return null;

  const trimmedPath = path.trim();

  // Already a full HTTP(S) URL - validate protocol
  if (trimmedPath.startsWith("http://") || trimmedPath.startsWith("https://")) {
    try {
      const url = new URL(trimmedPath);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        console.warn(`[Security] Invalid protocol in URL: ${url.protocol}`);
        return null;
      }
      return trimmedPath;
    } catch {
      console.warn(`[Security] Invalid URL format: ${trimmedPath}`);
      return null;
    }
  }

  // Block dangerous protocols
  const dangerousProtocols = [
    "javascript:",
    "data:",
    "vbscript:",
    "file:",
    "about:",
  ];
  if (
    dangerousProtocols.some((proto) =>
      trimmedPath.toLowerCase().startsWith(proto),
    )
  ) {
    console.warn(`[Security] Dangerous protocol detected: ${trimmedPath}`);
    return null;
  }

  // Relative path - prefix with API_BASE
  return `${API_BASE}${trimmedPath}`;
}

// ---------------------------------------------------------------------------
// fetchApi - typed fetch wrapper with structured error handling
// ---------------------------------------------------------------------------
export async function fetchApi<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  try {
    // Read admin token from localStorage (non-critical - wrap in try/catch)
    let adminToken: string | null = null;
    try {
      adminToken = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || localStorage.getItem(LEGACY_ADMIN_TOKEN_STORAGE_KEY);
      if (!localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) && adminToken) {
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, adminToken);
      }
    } catch { /* localStorage unavailable (SSR / worker env) */ }

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(adminToken ? { "X-Admin-Token": adminToken } : {}),
        ...options?.headers,
      },
    });

    // Handle 204 No Content / empty body
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return undefined as T;
    }

    // Attempt JSON parse
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      if (!res.ok) {
        throw new ApiError(
          "INVALID_RESPONSE",
          "服务器返回了无效的响应格式",
          res.status,
          undefined,
          { method: options?.method || "GET", url: endpoint },
        );
      }
      // OK response with unparseable body - treat as void
      return undefined as T;
    }

    if (!res.ok) {
      // Extract structured error envelope: { error: { code, message, details } }
      const errorObj = data as unknown as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      const errorData = errorObj.error || {};
      throw new ApiError(
        errorData.code || "API_ERROR",
        errorData.message || res.statusText || "请求失败",
        res.status,
        errorData.details,
        { method: options?.method || "GET", url: endpoint },
        typeof data === "string" ? data : JSON.stringify(data),
      );
    }

    return data;
  } catch (error) {
    // Do NOT double-wrap already-thrown ApiError instances
    if (error instanceof ApiError) {
      throw error;
    }

    // Network error or other unexpected failure
    throw new ApiError(
      "NETWORK_ERROR",
      "网络连接失败，请检查您的网络设置",
      undefined,
      { originalError: String(error) },
      { method: options?.method || "GET", url: endpoint },
    );
  }
}

// ---------------------------------------------------------------------------
// Re-export all API object groups
// ---------------------------------------------------------------------------
export { projectsApi } from "./projectsApi";
export { shotsApi } from "./shotsApi";
export { charactersApi } from "./charactersApi";
export { versionsApi } from "./versionsApi";
export { configApi } from "./configApi";
export { styleTemplatesApi } from "./styleTemplatesApi";
export { exportApi } from "./exportApi";
export { consistencyApi } from "./consistencyApi";
