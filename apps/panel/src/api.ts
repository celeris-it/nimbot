import { translateApiError } from "./i18n/errors.js";
import type { Translate } from "./i18n/language.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public params?: unknown,
  ) {
    super(message);
  }

  display(t: Translate) {
    return translateApiError(t, this.code, this.params, this.message);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => undefined)) as
      { error?: string; code?: string; params?: unknown } | undefined;
    throw new ApiError(
      response.status,
      data?.error ??
        "The request could not be completed. Refresh the status before retrying.",
      data?.code,
      data?.params,
    );
  }
  return response.json() as Promise<T>;
}

export function post<T>(path: string, fields: Record<string, string> | string) {
  return request<T>(path, {
    method: "POST",
    ...(typeof fields === "string"
      ? { body: fields, headers: { "Content-Type": "application/json" } }
      : { body: new URLSearchParams(fields) }),
  });
}
