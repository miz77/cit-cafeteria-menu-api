# Ingest Tool

GitHub Actions で実行する Node.js ingest job です。

役割:

- source PDF を発見する
- source PDF を順番に取得する
- source limit を適用する
- 週次 PDF の日付列を解析する
- `rawText` / `lines` と控えめな `menuItems` document を生成する
- schema に対して JSON を検証する
- endpoint-ready JSON string を Workers KV に upload する

この package は PDF parser library に依存できます。API Worker から import してはいけません。

## Dry Run

Cloudflare KV に書き込まずに ingest を実行します。

```bash
pnpm --filter @cit-cafeteria/ingest dry-run
```

この command は公開されている CITサービスの学食ページ / PDF を取得し、解析結果を output directory に JSON として書き出します。

主な出力:

```text
manifest.json
source__v1__week__current.json
health__v1__current.json
menu__v1__date__YYYY-MM-DD__all.json
menu__v1__date__YYYY-MM-DD__location__LOCATION_ID.json
menu__v1__week__YYYY-MM-DD__all.json
menu__v1__week__YYYY-MM-DD__location__LOCATION_ID.json
```

KV 書き込みを有効にする前に、dry-run output で parser の品質を確認してください。
