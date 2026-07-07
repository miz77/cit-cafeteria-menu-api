# Ingest Fixtures

これらの fixtures は、公開されている CITサービスのメニュー PDF から抽出した座標付き text item です。

source PDF や screenshot はコミットしないでください。

fixture には、公開 PDF に由来するメニュー文字列が含まれる場合があります。これはテスト用 artifact であり、MIT licensed menu data ではありません。

新習志野 fixtures を手元で追加する手順:

```bash
curl -L https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/s1.pdf -o /tmp/cit-s1.pdf
curl -L https://www.cit-s.com/wp/wp-content/themes/cit/syokudo/s2.pdf -o /tmp/cit-s2.pdf
FIXTURE_WEEK=20260706 tools/ingest/node_modules/.bin/tsx -e 'import { readFileSync, writeFileSync } from "node:fs"; import { extractTextItemsFromPdf } from "./tools/ingest/src/pdf.ts"; void (async () => { const week = process.env.FIXTURE_WEEK; if (!week) throw new Error("FIXTURE_WEEK is required"); const jobs = [["/tmp/cit-s1.pdf", `tools/ingest/fixtures/shinnarashino-1f-${week}.json`], ["/tmp/cit-s2.pdf", `tools/ingest/fixtures/shinnarashino-2f-${week}.json`]] as const; for (const [input, output] of jobs) { const extraction = await extractTextItemsFromPdf(new Uint8Array(readFileSync(input))); writeFileSync(output, `${JSON.stringify(extraction, null, 2)}\n`); } })();'
```

既存 fixtures はレイアウトバリエーションとして残し、新しい週は `shinnarashino-1f-YYYYMMDD.json` /
`shinnarashino-2f-YYYYMMDD.json` のように追加してください。

追加した fixtures をコミットする前に、parser output を source PDF と照合してください。
