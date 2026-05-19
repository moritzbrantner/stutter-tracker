export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "request_too_large"
  | "invalid_request"
  | "native_worker_unavailable"
  | "transcription_failed"
  | "not_found"
  | "internal_error";

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly expose = true,
  ) {
    super(message);
  }
}

export type ResponseHeaders = Record<string, string>;

export function jsonResponse(value: unknown, status = 200, headers: ResponseHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...headers,
      "content-type": "application/json",
    },
  });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  headers: ResponseHeaders = {},
) {
  return jsonResponse({ error: { code, message } }, status, headers);
}

export async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError("invalid_request", "content-type must be application/json", 400);
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    throw new HttpError("request_too_large", "request body is too large", 413);
  }

  const payload = await request.arrayBuffer();
  if (payload.byteLength > maxBodyBytes) {
    throw new HttpError("request_too_large", "request body is too large", 413);
  }

  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new HttpError("invalid_request", "request body must be valid JSON", 400);
  }
}
