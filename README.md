# CIT Cafeteria Menu API

千葉工業大学の学食メニューを JSON で取得できる非公式 API です。

## 使い始める

ブラウザで試す:

https://cit-cafeteria-menu-api.miz77.workers.dev/api/v1/locations/tsudanuma/menus/today

curl:

```bash
curl https://cit-cafeteria-menu-api.miz77.workers.dev/api/v1/locations/tsudanuma/menus/today
```

食堂 ID:

```text
tsudanuma
shinnarashino-1f
shinnarashino-2f
```

日付は `Asia/Tokyo` 基準です。

表示には `location.menuItems` を使います。`location.status` が `ok` 以外の場合や `menuItems` が空の場合は、必要に応じて `location.menuText.lines` をフォールバックにしてください。

詳しい仕様:

- API リファレンス: https://cit-cafeteria-menu-api.miz77.workers.dev/docs
- フィールド説明: [docs/api-guide.md](docs/api-guide.md)
- OpenAPI: [docs/openapi.yaml](docs/openapi.yaml)

## 状態

Beta。API は利用できますが、PDF のレイアウト変更により抽出結果が変わる可能性があります。

## API

```text
GET /api/v1/locations
GET /api/v1/menus/today
GET /api/v1/menus/week
GET /api/v1/menus/{date}
GET /api/v1/locations/{locationId}/menus/today
GET /api/v1/locations/{locationId}/menus/week
GET /api/v1/locations/{locationId}/menus/{date}
GET /api/v1/sources
GET /api/v1/health
GET /api/v1/openapi.json
```

## 構成

CITサービスが公開している学食メニュー PDF を GitHub Actions で取得して解析し、API 用の JSON として Cloudflare Workers KV に保存します。
API リクエストには、保存済み JSON を読み出して応答します。

Cloudflare Worker は軽量に保っています。
リクエストごとに対応する Workers KV のキーを読み、保存済み JSON 文字列を返します。
Worker 内では PDF の取得と解析、KV への書き込み、通知サービス呼び出しを行いません。

PDF の取得と解析、スキーマ検証、KV へのアップロードは `tools/ingest` を GitHub Actions で実行して行います。

## 開発

```bash
corepack enable
pnpm install
pnpm check
pnpm test
pnpm typecheck
```

Worker のビルドと検証:

```bash
pnpm --filter @cit-cafeteria/api-worker build
pnpm --filter @cit-cafeteria/api-worker check:forbidden-deps
pnpm --filter @cit-cafeteria/api-worker check:bundle
```

KV に書き込まずに ingest を確認:

```bash
pnpm --filter @cit-cafeteria/ingest dry-run
```

運用手順は [docs/operations.md](docs/operations.md) を参照してください。

## ライセンス

このリポジトリ内のソースコードとドキュメントは MIT License です。

生成されるメニューデータは、CITサービスが公開している PDF に由来する便利用データです。このリポジトリは元 PDF や第三者のメニュー内容の所有権を主張しません。また、生成メニューデータを MIT License の対象とは説明しません。

このプロジェクトは非公式であり、千葉工業大学およびCITサービスとは関係ありません。公式情報は元 PDF を確認してください。
