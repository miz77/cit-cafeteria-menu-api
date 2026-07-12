# Operations

## 必要な secrets

GitHub Actions に以下の secrets を設定します。

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
CLOUDFLARE_KV_NAMESPACE_ID
```

Cloudflare API token は、対象 Workers KV namespace への書き込みと Worker deploy に必要な最小権限にしてください。

GitHub CLI を使う場合は、作業ディレクトリで次を実行します。

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
gh secret set CLOUDFLARE_KV_NAMESPACE_ID
```

各コマンドの実行後に、`gh` が値の入力を求めます。
別のディレクトリから設定する場合は `-R OWNER/REPO` を付けてください。

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

scheduled ingest は GitHub repository variable `ENABLE_SCHEDULED_INGEST=true` を設定した repository だけで実行します。
fork や clone 先で自動的にCITサービスへ HTTP リクエストを送り続けないための opt-in gate です。
本番運用する repository では、GitHub の Settings > Secrets and variables > Actions > Variables に `ENABLE_SCHEDULED_INGEST=true` を設定してください。
この設定がない場合、scheduled run は実行されず skip されます。
GitHub CLI を使う場合は、次を実行します。

```bash
gh variable set ENABLE_SCHEDULED_INGEST --body true
```


各 workflow run は、再試行で回復する可能性がある ingest または upload の失敗だけを最大 3 回再試行します。
parse 失敗、`source_changed`、secrets の不足、休業設定の破損など、再試行しても回復しない失敗は再試行しません。

### status と health

メニュー endpoint の `overallStatus` と ingest の health は別の指標です。`overallStatus` はその日・週の公開データの充足度を表し、health は今回の解析結果を運用上信頼できるかを表します。

- `closed` は休業を正常に判定できた状態、`not_published` はメニュー未掲載の状態として、どちらも ingest health を悪化させません。
- 一部の日・食堂だけが `unknown`、取得失敗、解析失敗などの場合、health は `degraded` です。診断用データを含むKVは更新し、生成済みskipは行いません。
- 生成した全日・全食堂が不確実な場合、healthを `failed` として診断用KVを更新した後、非再試行エラーで終了します。dry-runは同じ成果物を出力して成功終了します。
- 日付を1件も生成できなかった場合は従来どおり、原因に応じて再試行可能性を判定します。

KV書き込みは逐次処理でありtransactionではありません。失敗調査では `health:v1:current`、`health:v1:last-error`、`source:v1:week:current` とGitHub Actionsのsummaryを併せて確認してください。`unknown` の日も `menuText.rawText`、`unassignedLines`、parser warningを保持しますが、誤配信を避けるため `menuItems` は空になります。

手動実行では `YYYY-MM-DD` 形式の `target_date` を任意で指定できます。
`force=true` を指定すると、今週分が生成済みでもCITサービスから再取得します。
週中の PDF 訂正を反映する場合や、長期休業明けの再開日に手動更新する場合は `force=true` を指定してください。

### 休業期間

長期休業などで scheduled ingest を止めたい期間は `tools/ingest/pauses.json` に追加します。

```json
{
  "pausePeriods": [
    { "from": "2026-07-18", "to": "2026-09-17", "reason": "summer_break" }
  ]
}
```

`from` と `to` は `Asia/Tokyo` の日付で、どちらも skip 対象期間に含まれます。
`to` には、scheduled ingest を止めたい最終日を指定します。
休業最終日までCITサービスへ HTTP リクエストを送らない場合は、休業最終日を `to` に指定してください。
営業再開日が次の scheduled run より前に来る場合は、必要に応じて `force=true` で手動実行してください。

`schedule` で起動した run が休業期間内の場合、CITサービスへ HTTP リクエストを送らず、成功として終了します。
手動実行と dry-run には、休業期間による skip を適用しません。
ただし、手動実行で生成済み skip も避ける場合は `force=true` を指定してください。
休業設定 JSON が壊れている場合は、手動実行、scheduled run、dry-run のいずれもCITサービスへ HTTP リクエストを送る前に失敗します。

### 生成済み skip

今週分が既に正常生成済みの場合、backup の scheduled run はCITサービスへ HTTP リクエストを送らず、成功として終了します。
判定には `health:v1:last-update` と `menu:v1:week:YYYY-MM-DD:all` の両方を使います。

この skip により、週中にCITサービス側で PDF が訂正されても自動では拾いません。
訂正を反映したい場合は `Update cafeteria menu data` を `force=true` で手動実行してください。

長期休業明けの月曜にCITサービス側の PDF がまだ更新されていない場合、scheduled ingest は今週分のメニュー JSON を生成しないことがあります。
再開日に手動実行する場合は `force=true` を指定してください。

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

結合セルはPDFの縦横罫線から列範囲を復元します。内部境界が隣接行で確認できない、外周罫線が閉じない、同じrow band内の別列に競合テキストがある、など証拠が不足する場合は展開せず `ambiguous_column_span_not_expanded` を記録します。`pdf_operator_*` または `pdf_ruling_*` warningがある場合も基本テキスト抽出は継続されます。dependency更新時は、対応するPDF.js/unpdf versionのcharacterization testと手元PDFの罫線抽出を再確認してください。
