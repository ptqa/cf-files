const MAX_TTL_SECONDS = 604800;

export type UploadConfig = {
  endpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  uploadTtl: number;
  downloadTtl: number;
};

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function ttl(value: unknown, fallback: number, name: string): number {
  const raw = value === undefined ? String(fallback) : value;
  if (
    typeof raw !== "string" ||
    !/^[1-9]\d*$/.test(raw)
  ) {
    throw new Error(`invalid ${name}`);
  }

  const seconds = Number(raw);
  if (seconds > MAX_TTL_SECONDS) {
    throw new Error(`invalid ${name}`);
  }
  return seconds;
}

function endpoint(value: unknown): URL {
  const raw = required(value, "S3_ENDPOINT");
  if (raw !== raw.trim()) throw new Error("invalid S3_ENDPOINT");

  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("invalid S3_ENDPOINT");
  }
  return parsed;
}

function bucket(value: unknown): string {
  const raw = required(value, "S3_BUCKET");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(raw) ||
    /\.\.|\.-|-\./.test(raw) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)
  ) {
    throw new Error("invalid S3_BUCKET");
  }
  return raw;
}

function region(value: unknown): string {
  const raw = value === undefined ? "auto" : required(value, "S3_REGION");
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(raw)) {
    throw new Error("invalid S3_REGION");
  }
  return raw;
}

export function readConfig(env: Env): UploadConfig {
  return {
    endpoint: endpoint(env.S3_ENDPOINT),
    region: region(env.S3_REGION),
    bucket: bucket(env.S3_BUCKET),
    accessKeyId: required(env.S3_ACCESS_KEY_ID, "S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env.S3_SECRET_ACCESS_KEY, "S3_SECRET_ACCESS_KEY"),
    uploadTtl: ttl(env.UPLOAD_URL_TTL_SECONDS, 600, "UPLOAD_URL_TTL_SECONDS"),
    downloadTtl: ttl(
      env.DOWNLOAD_URL_TTL_SECONDS,
      MAX_TTL_SECONDS,
      "DOWNLOAD_URL_TTL_SECONDS",
    ),
  };
}
