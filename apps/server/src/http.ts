export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "request_too_large"
  | "invalid_request"
  | "server_busy"
  | "request_cancelled"
  | "native_worker_unavailable"
  | "transcription_failed"
  | "not_found"
  | "speaker_not_found"
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
export type ServerFormData = Awaited<ReturnType<Request["formData"]>>;

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

  const payload = await readBodyWithLimit(request, maxBodyBytes, "request body is too large");
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new HttpError("invalid_request", "request body must be valid JSON", 400);
  }
}

/** Room for multipart boundaries and the small text fields next to the audio part. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export async function readFormDataWithLimit(
  request: Request,
  maxBytes: number,
): Promise<ServerFormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new HttpError("invalid_request", "content-type must be multipart/form-data", 400);
  }

  // The whole body is bounded, not just the audio part, so extra parts cannot bypass the limit.
  const payload = await readBodyWithLimit(
    request,
    maxBytes + MULTIPART_OVERHEAD_BYTES,
    "audio upload is too large",
  );
  let formData: ServerFormData;
  try {
    formData = await new Response(payload, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new HttpError("invalid_request", "request body must be valid multipart form data", 400);
  }
  const audio = formData.get("audio");
  if (audio instanceof File && audio.size > maxBytes) {
    throw new HttpError("request_too_large", "audio upload is too large", 413);
  }
  return formData;
}

// Counts bytes while reading, so a chunked body without Content-Length cannot exceed the limit.
async function readBodyWithLimit(request: Request, maxBytes: number, message: string) {
  const tooLarge = () => new HttpError("request_too_large", message, 413);
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw tooLarge();
  }
  if (!request.body) {
    return new Uint8Array();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
