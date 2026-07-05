# Operations

## 必要な secrets

GitHub Actions に以下の secrets を設定します。

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_KV_NAMESPACE_ID
```

Cloudflare API token は、対象 Workers KV namespace への書き込みと Worker deploy に必要な最小権限にしてください。

## Worker の KV binding

`apps/api-worker/wrangler.toml` には公開リポジトリ用の placeholder KV namespace ID を置いています。

deploy workflow は、Wrangler 実行前に `CLOUDFLARE_KV_NAMESPACE_ID` の値で placeholder を置き換えます。

ローカルで deploy する場合は、同じ置換を手元で行ってから実行してください。

```bash
pnpm --filter @cit-cafeteria/api-worker exec wrangler deploy
```

## 定期更新

ingest workflow は次の時刻に実行します。

```text
月曜 05:07 JST: 通常実行
月曜 08:17 JST: backup
火曜 08:27 JST: backup
```

各 workflow run は ingest/upload step だけを最大 3 回 retry します。手動実行では `YYYY-MM-DD` 形式の `target_date` を任意で指定できます。

## Dry Run

Cloudflare KV に書き込まずに ingest を確認します。

```bash
pnpm --filter @cit-cafeteria/ingest dry-run
```

主な出力ファイル:

```text
manifest.json
source__v1__week__current.json
health__v1__current.json
menu__v1__date__YYYY-MM-DD__all.json
menu__v1__date__YYYY-MM-DD__location__LOCATION_ID.json
menu__v1__week__YYYY-MM-DD__all.json
menu__v1__week__YYYY-MM-DD__location__LOCATION_ID.json
```

## デプロイ

基本手順:

1. `Update cafeteria menu data` を実行して KV にデータを書き込みます。
2. `Deploy API Worker` を実行して Worker を公開します。
3. `/api/v1/health`、`/api/v1/sources`、任意のメニュー endpoint を確認します。

ローカルで Worker を検証する場合:

```bash
pnpm --filter @cit-cafeteria/api-worker build
pnpm --filter @cit-cafeteria/api-worker check:forbidden-deps
pnpm --filter @cit-cafeteria/api-worker check:bundle
```

## トラブルシュート

1. `/api/v1/health` を確認します。
2. `/api/v1/sources` を確認します。
3. GitHub Actions の run log または step summary にある食堂別 ingest summary を確認します。
4. PDF が取得可能か、サイズ・ページ数上限内かを確認します。
5. PDF の表レイアウトが変わっている場合は parser と fixtures を更新します。
