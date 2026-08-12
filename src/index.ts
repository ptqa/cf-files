import { readConfig } from "./config";
import { signUrls } from "./s3";

type UploadBody = {
  filename: string;
  content_type: string;
};

const MEDIA_TYPE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function json(value: object, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function authenticate(
  authorization: string | null,
  expected: unknown,
): Promise<boolean> {
  if (authorization === null || !/^Bearer [^\s]+$/.test(authorization)) {
    return false;
  }

  const provided = authorization.slice("Bearer ".length);
  if (typeof expected !== "string" || expected.trim().length === 0) {
    throw new Error("missing UPLOAD_TOKEN");
  }

  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function isUploadBody(value: unknown): value is UploadBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    typeof body.filename === "string" &&
    typeof body.content_type === "string"
  );
}

function safeFilename(filename: string): string | null {
  const basename = filename.replace(/[\\/]+/g, "/").split("/").at(-1) ?? "";
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "");
  if (
    safe.length === 0 ||
    safe.length > 255 ||
    safe === "." ||
    safe === ".."
  ) {
    return null;
  }
  return safe;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }
    if (url.pathname !== "/v1/uploads" || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }

    try {
      if (!(await authenticate(request.headers.get("Authorization"), env.UPLOAD_TOKEN))) {
        return json({ error: "unauthorized" }, 401);
      }
    } catch {
      return json({ error: "internal_error" }, 500);
    }

    const contentType = request.headers.get("Content-Type");
    if (
      contentType === null ||
      contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    ) {
      return json({ error: "invalid_request" }, 400);
    }

    const contentLength = request.headers.get("Content-Length");
    if (
      contentLength !== null &&
      /^\d+$/.test(contentLength) &&
      Number(contentLength) > 8192
    ) {
      return json({ error: "payload_too_large" }, 413);
    }

    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let bytes: Uint8Array;
    try {
      if (reader !== undefined) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8192) {
            await reader.cancel().catch(() => {});
            return json({ error: "payload_too_large" }, 413);
          }
          chunks.push(value);
        }
      }

      bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } catch {
      await reader?.cancel().catch(() => {});
      return json({ error: "internal_error" }, 500);
    }

    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
      );
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (!isUploadBody(value)) return json({ error: "invalid_request" }, 400);

    try {
      const config = readConfig(env);
      if (!MEDIA_TYPE.test(value.content_type)) {
        return json({ error: "invalid_request" }, 400);
      }

      const filename = safeFilename(value.filename);
      if (filename === null) return json({ error: "invalid_request" }, 400);
      const key = `${crypto.randomUUID()}/${filename}`;
      const { uploadUrl, downloadUrl } = await signUrls(config, key, value.content_type);
      const alt = filename.replace(/\.[A-Za-z0-9_-]+$/, "") || filename;

      return json({
        key,
        upload_url: uploadUrl,
        download_url: downloadUrl,
        upload_expires_in: config.uploadTtl,
        download_expires_in: config.downloadTtl,
        markdown: `![${alt}](${downloadUrl})`,
      });
    } catch {
      return json({ error: "internal_error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
