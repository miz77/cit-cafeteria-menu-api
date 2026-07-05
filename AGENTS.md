# AGENTS.md

coding agent 向けの短い入口です。詳細は作業に必要な時だけ読んでください。

## 作業の入口

- API route / response: `apps/api-worker`, `docs/openapi.yaml`, `docs/api-guide.md`
- schema / type: `packages/schema`, `docs/schemas/`
- PDF ingest / KV write / workflow: `tools/ingest`, `docs/operations.md`
- secrets / Worker 境界 / 依存関係: `SECURITY.md`

## 守ること

- API Worker は KV の pre-serialized JSON を返すだけにする。
- Worker request path で PDF 取得・解析、KV 書き込み、外部通知、大きな parse/filter をしない。
- Worker に PDF/OCR/画像処理/Discord 系依存を入れない。正確な禁止一覧は `SECURITY.md` と `check:forbidden-deps`。
- Cloudflare Workers KV だけを使う。R2 は追加しない。
- Discord bot/webhook runtime code はこの repository に追加しない。
- `.dev.vars`, secrets, 実 PDF, 実 PDF screenshot, logo をコミットしない。
- 実メニューデータを MIT licensed と説明しない。MIT は code と docs に適用する。
- route、OpenAPI、schema、共有型、KV key を揃える。

## コマンド

- Install dependencies: `pnpm install`
- Run all checks: `pnpm check`
- Run tests: `pnpm test`
- Run typecheck: `pnpm typecheck`
- Run ingest dry-run: `pnpm ingest:dry-run`
- For API Worker changes: `pnpm --filter @cit-cafeteria/api-worker build`, `pnpm --filter @cit-cafeteria/api-worker check:forbidden-deps`, `pnpm --filter @cit-cafeteria/api-worker check:bundle`

## 完了条件

変更範囲に応じた最小限のチェックを実行してください。API Worker を変更した場合は、可能な限り build、forbidden-dependency check、bundle check も含めてください。
