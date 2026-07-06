# セキュリティポリシー

## Secrets の扱い

secrets をコミットしないでください。

deploy/update に必要な値は GitHub Actions secrets または Cloudflare secrets に保存します。

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_KV_NAMESPACE_ID
```

Cloudflare API token は、対象 Workers KV namespace への書き込みと Worker deploy に必要な最小権限にしてください。

## 公開 API

公開 API handler は、PDF の取得・解析、KV 書き込み、外部通知サービス呼び出しを行いません。

公開 API handler は Cloudflare Workers KV を読むだけにしてください。

例外として `/docs` は固定 `DOCS_URL` へ redirect できます。open redirect を避けるため、request path、query、host、referer を `Location` に反映しないでください。

## 依存関係の境界

API Worker は PDF parser package や Discord package に依存しません。

`apps/api-worker` で禁止する依存:

```text
unpdf
pdfjs-dist
canvas
tesseract.js
sharp
discord.js
```
