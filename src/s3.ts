import { AwsClient } from "aws4fetch";
import type { UploadConfig } from "./config";

function objectUrl(config: UploadConfig, key: string): URL {
  const url = new URL(config.endpoint.toString());
  const prefix = url.pathname.replace(/\/+$/, "");
  const path = [
    config.bucket,
    ...key.split("/"),
  ].map(encodeURIComponent).join("/");
  url.pathname = `${prefix}/${path}`;
  return url;
}

export async function signUrls(
  config: UploadConfig,
  key: string,
  contentType: string,
): Promise<{ uploadUrl: string; downloadUrl: string }> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region,
  });

  const upload = objectUrl(config, key);
  upload.searchParams.set("X-Amz-Expires", String(config.uploadTtl));
  const signedUpload = await client.sign(upload, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    aws: { signQuery: true, allHeaders: true },
  });

  const download = objectUrl(config, key);
  download.searchParams.set("X-Amz-Expires", String(config.downloadTtl));
  const signedDownload = await client.sign(download, {
    method: "GET",
    aws: { signQuery: true },
  });

  return {
    uploadUrl: signedUpload.url,
    downloadUrl: signedDownload.url,
  };
}
