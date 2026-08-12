# cf-files

A small Cloudflare Worker that gives coding agents presigned S3 PUT and GET URLs for temporary screenshots. The bucket stays private: files upload and download directly between the client and S3-compatible storage, while the Worker only authenticates upload requests and signs URLs.

The PUT URL defaults to 10 minutes, the GET URL to 7 days, and a bucket lifecycle rule deletes objects after 8 days. There is no file proxy, listing, UI, user system, or cleanup process.

## Configure

Install dependencies, copy the example configuration, and replace its endpoint, bucket, and optional custom domain with your values:

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is intentionally ignored so deployment-specific account IDs, bucket names, and domains are not committed.

Required configuration:

| Variable | Purpose | Example |
| --- | --- | --- |
| `S3_ENDPOINT` | S3-compatible API endpoint | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | SigV4 region | `auto` for R2, `us-east-1` for AWS |
| `S3_BUCKET` | Private bucket name | `agent-files` |
| `UPLOAD_URL_TTL_SECONDS` | PUT URL lifetime, 1-604800 | `600` |
| `DOWNLOAD_URL_TTL_SECONDS` | GET URL lifetime, 1-604800 | `604800` |

Set secrets interactively:

```bash
npx wrangler secret put UPLOAD_TOKEN
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
```

For local development, put the same three secrets in an uncommitted `.dev.vars` file, then run:

```bash
npx wrangler dev
```

### R2

Create an R2 API token restricted to Object Read & Write for the private bucket. Use its access key ID and secret access key, with:

```jsonc
"S3_ENDPOINT": "https://<account-id>.r2.cloudflarestorage.com",
"S3_REGION": "auto",
"S3_BUCKET": "agent-files"
```

R2 presigned URLs use the S3 API hostname, not an R2 custom domain.

### AWS S3

Use credentials restricted to `s3:GetObject` and `s3:PutObject` for the bucket, with:

```jsonc
"S3_ENDPOINT": "https://s3.us-east-1.amazonaws.com",
"S3_REGION": "us-east-1",
"S3_BUCKET": "agent-files"
```

Path-style S3 endpoints also make the service suitable for MinIO and similar backends that implement SigV4 presigned URLs. Use HTTP endpoints only for trusted local development; deployments should use HTTPS.

## Deploy

```bash
npm install
npx wrangler deploy
```

Keep the bucket private. The generated GET URL carries its own temporary SigV4 authorization, so GitHub and Bitbucket can fetch it without an authorization header.

## Use

```bash
RESULT=$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"result.png","content_type":"image/png"}' \
  https://files.example.com/v1/uploads)

UPLOAD_URL=$(printf '%s' "$RESULT" | jq -r .upload_url)

curl --fail \
  -X PUT \
  -H "Content-Type: image/png" \
  --upload-file result.png \
  "$UPLOAD_URL"

printf '%s\n' "$RESULT" | jq -r .markdown
```

The `Content-Type` on the PUT must match the requested `content_type` because it is covered by the signature.
Any valid media type is accepted. File bytes and file size are not proxied or limited by the Worker; backend single-PUT limits still apply.

## Expiration

Configure storage lifecycle deletion rather than adding cleanup code to the Worker.

For R2, open the bucket in the Cloudflare dashboard, select **Settings**, add an **Object Lifecycle Rule** applying to all objects, and expire objects after 8 days. The equivalent Wrangler command is:

```bash
npx wrangler r2 bucket lifecycle add agent-files --expire-days 8
```

For AWS S3, save this lifecycle configuration outside the repository and apply it with the AWS CLI:

```json
{
  "Rules": [
    {
      "ID": "delete-agent-files-after-8-days",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "Expiration": { "Days": 8 }
    }
  ]
}
```

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket agent-files \
  --lifecycle-configuration file://lifecycle.json
```

Lifecycle deletion may occur after an object becomes eligible; access still stops when the 7-day signed GET URL expires.

## Verify

```bash
npm test
npm run typecheck
npm run types:check
```
