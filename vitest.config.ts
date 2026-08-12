import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.example.jsonc" },
      miniflare: {
        bindings: {
          S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
          S3_REGION: "auto",
          S3_BUCKET: "test-bucket",
          S3_ACCESS_KEY_ID: "TESTACCESSKEY",
          S3_SECRET_ACCESS_KEY: "test-secret-key",
          UPLOAD_TOKEN: "test-upload-token",
          UPLOAD_URL_TTL_SECONDS: "600",
          DOWNLOAD_URL_TTL_SECONDS: "604800",
        },
      },
    }),
  ],
});
