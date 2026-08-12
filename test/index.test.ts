import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const uploadToken = "test-upload-token";
const accessKey = "TESTACCESSKEY";
const secretKey = "test-secret-key";
const uploadTtl = 600;
const downloadTtl = 604800;

type JsonObject = Record<string, unknown>;

async function request(
  path: string,
  init: RequestInit = {},
  requestEnv: Env = env,
): Promise<{ response: Response; body: JsonObject }> {
  const response = await worker.fetch(
    new Request(`https://example.com${path}`, init),
    requestEnv,
  );
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return { response, body: (await response.json()) as JsonObject };
}

function uploadRequest(
  body: unknown = { filename: "photo.png", content_type: "image/png" },
  token: string | null = uploadToken,
  requestEnv: Env = env,
) {
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return request(
    "/v1/uploads",
    {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    requestEnv,
  );
}

function signedQuery(value: unknown): URL {
  expect(typeof value).toBe("string");
  const url = new URL(value as string);
  expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(url.searchParams.get("X-Amz-Credential")).toBeTruthy();
  expect(url.searchParams.get("X-Amz-Date")).toMatch(/^\d{8}T\d{6}Z$/);
  expect(url.searchParams.get("X-Amz-Expires")).toBeTruthy();
  expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBeTruthy();
  return url;
}

function bodyWithBytes(size: number): string {
  const body = JSON.stringify({
    filename: "photo.png",
    content_type: "image/png",
  });
  return body + " ".repeat(size - body.length);
}

describe("temporary file signing worker", () => {
  it("returns health without configuration", async () => {
    const { response, body } = await request("/health", {}, {} as Env);

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("accepts a valid bearer token", async () => {
    const { response, body } = await uploadRequest();

    expect(response.status).toBe(200);
    expect(body.markdown).toBe(`![photo](${body.download_url})`);
  });

  it.each([
    ["missing token", null],
    ["wrong token", "wrong-token"],
  ])("rejects a %s", async (_name, token) => {
    const { response, body } = await uploadRequest(undefined, token);

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it("authenticates before content type, body size, and signing config", async () => {
    const { response, body } = await request(
      "/v1/uploads",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "text/plain",
          "Content-Length": "9000",
        },
        body: "x".repeat(9000),
      },
      { UPLOAD_TOKEN: uploadToken } as Env,
    );

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "unauthorized" });
  });

  it.each([
    [8192, 200, undefined],
    [8193, 413, "payload_too_large"],
  ])("bounds streamed JSON bodies at %i bytes", async (size, status, error) => {
    const { response, body } = await uploadRequest(bodyWithBytes(size));

    expect(response.status).toBe(status);
    if (error !== undefined) expect(body).toEqual({ error });
  });

  it("short-circuits an oversized Content-Length", async () => {
    const { response, body } = await request("/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "application/json",
        "Content-Length": "8193",
      },
      body: bodyWithBytes(100),
    });

    expect(response.status).toBe(413);
    expect(body).toEqual({ error: "payload_too_large" });
  });

  it("enforces the streamed limit when Content-Length understates the body", async () => {
    const chunks = [new Uint8Array(4096), new Uint8Array(4097)];
    const { response, body } = await request("/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: new ReadableStream({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      }),
    });

    expect(response.status).toBe(413);
    expect(body).toEqual({ error: "payload_too_large" });
  });

  it("returns a detail-free JSON 500 when the request stream errors", async () => {
    const { response, body } = await request("/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("request stream failed"));
        },
      }),
    });

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({ error: "internal_error" });
  });

  it.each([
    ["missing filename", { content_type: "image/png" }],
    ["missing content type", { filename: "photo.png" }],
  ])("rejects %s", async (_name, body) => {
    const { response } = await uploadRequest(body);

    expect(response.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { response } = await uploadRequest("not-json");

    expect(response.status).toBe(400);
  });

  it("rejects upload requests without application/json", async () => {
    const { response, body } = await request("/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({
        filename: "photo.png",
        content_type: "image/png",
      }),
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_request" });
  });

  it("creates unique, path-safe keys using only the filename basename", async () => {
    const payload = {
      filename: "../../nested/../photo.png",
      content_type: "image/png",
    };
    const first = await uploadRequest(payload);
    const second = await uploadRequest(payload);
    const firstKey = first.body.key as string;
    const secondKey = second.body.key as string;

    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(firstKey).not.toBe(secondKey);
    for (const key of [firstKey, secondKey]) {
      expect(key).toMatch(/^[A-Za-z0-9._/-]+$/);
      expect(key.split("/")).not.toContain("..");
      expect(key.split("/").at(-1)).toBe("photo.png");
    }
  });

  it("rejects a sanitized filename longer than 255 ASCII characters", async () => {
    const { response, body } = await uploadRequest({
      filename: `${"a".repeat(252)}.png`,
      content_type: "image/png",
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_request" });
  });

  it("produces SigV4 upload URLs with content-type signed", async () => {
    const { response, body } = await uploadRequest();
    const uploadUrl = signedQuery(body.upload_url);
    const signedHeaders = uploadUrl.searchParams
      .get("X-Amz-SignedHeaders")!
      .split(";");

    expect(response.status).toBe(200);
    expect(body.upload_expires_in).toBe(uploadTtl);
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe(String(uploadTtl));
    expect(signedHeaders).toContain("content-type");
  });

  it("produces SigV4 download URLs signed with exactly host", async () => {
    const { response, body } = await uploadRequest();
    const downloadUrl = signedQuery(body.download_url);
    const signedHeaders = downloadUrl.searchParams
      .get("X-Amz-SignedHeaders")!
      .split(";");

    expect(response.status).toBe(200);
    expect(body.download_expires_in).toBe(downloadTtl);
    expect(downloadUrl.searchParams.get("X-Amz-Expires")).toBe(
      String(downloadTtl),
    );
    expect(signedHeaders).toEqual(["host"]);
  });

  it("preserves an endpoint path prefix and port in path-style URLs", async () => {
    const overrides: Record<string, unknown> = {
      S3_ENDPOINT: "http://localhost:9000/minio",
    };
    const requestEnv: Env = { ...env, ...overrides };
    const { response, body } = await uploadRequest(undefined, uploadToken, requestEnv);
    const uploadUrl = new URL(body.upload_url as string);

    expect(response.status).toBe(200);
    expect(uploadUrl.origin).toBe("http://localhost:9000");
    expect(uploadUrl.pathname).toMatch(
      /^\/minio\/test-bucket\/[0-9a-f-]{36}\/photo\.png$/,
    );
  });

  it("does not serialize signing secrets or the upload token", async () => {
    const { body } = await uploadRequest();
    const serialized = JSON.stringify(body);
    const uploadUrl = signedQuery(body.upload_url);
    const downloadUrl = signedQuery(body.download_url);
    const nonSignedResponseFields = Object.entries(body)
      .filter(([field]) => !["upload_url", "download_url", "markdown"].includes(field))
      .map(([, value]) => value);

    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain(uploadToken);
    expect(JSON.stringify(nonSignedResponseFields)).not.toContain(accessKey);
    expect(uploadUrl.searchParams.get("X-Amz-Credential")?.split("/")[0]).toBe(accessKey);
    expect(downloadUrl.searchParams.get("X-Amz-Credential")?.split("/")[0]).toBe(accessKey);
    expect(body.markdown).toContain(body.download_url as string);
  });

  it.each([
    ["TTL 1", { UPLOAD_URL_TTL_SECONDS: "1" }, 1],
    ["TTL 604800", { UPLOAD_URL_TTL_SECONDS: "604800" }, 604800],
  ])("accepts %s", async (_name, overrides, expected) => {
    const requestEnv = { ...env, ...overrides } as Env;
    const { response, body } = await uploadRequest(undefined, uploadToken, requestEnv);

    expect(response.status).toBe(200);
    expect(body.upload_expires_in).toBe(expected);
  });

  it.each([
    ["TTL 0", { UPLOAD_URL_TTL_SECONDS: "0" }],
    ["TTL above maximum", { UPLOAD_URL_TTL_SECONDS: "604801" }],
    ["decimal TTL", { UPLOAD_URL_TTL_SECONDS: "1.5" }],
    ["bucket traversal", { S3_BUCKET: "foo..bar" }],
    ["bucket slash", { S3_BUCKET: "foo/bar" }],
    ["bucket IP form", { S3_BUCKET: "192.168.1.1" }],
    ["endpoint scheme", { S3_ENDPOINT: "ftp://example.com" }],
    ["region whitespace", { S3_REGION: "us east 1" }],
    ["empty access key", { S3_ACCESS_KEY_ID: "  " }],
    ["missing signing configuration", { S3_SECRET_ACCESS_KEY: undefined }],
  ])("returns a detail-free JSON 500 for %s", async (_name, overrides) => {
    const requestEnv = { ...env, ...overrides } as Env;
    const { response, body } = await uploadRequest(
      undefined,
      uploadToken,
      requestEnv,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({ error: "internal_error" });
  });

  it.each([
    ["document.pdf", "application/pdf"],
    ["archive.zip", "application/zip"],
    ["artifact.bin", "application/octet-stream"],
    ["notes.txt", "text/plain"],
  ])("accepts any valid content type for %s", async (filename, contentType) => {
    const { response } = await uploadRequest({
      filename,
      content_type: contentType,
    });

    expect(response.status).toBe(200);
  });

  it("rejects a malformed content type", async () => {
    const { response, body } = await uploadRequest({
      filename: "artifact.bin",
      content_type: "not a media type",
    });

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: "invalid_request" });
  });

  it("returns a boring JSON 404 for unknown paths and methods", async () => {
    const pathResponse = await request("/unknown");
    const methodResponse = await request("/health", { method: "POST" });
    const routeMethodResponse = await request("/v1/uploads", { method: "GET" });

    expect(pathResponse.response.status).toBe(404);
    expect(methodResponse.response.status).toBe(404);
    expect(routeMethodResponse.response.status).toBe(404);
    expect(pathResponse.body).toEqual({ error: "not_found" });
    expect(methodResponse.body).toEqual({ error: "not_found" });
    expect(routeMethodResponse.body).toEqual({ error: "not_found" });
  });
});
