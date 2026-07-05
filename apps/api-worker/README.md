# API Worker

公開 JSON API 用の Cloudflare Worker です。

この Worker は小さく、依存を軽く保ちます。

## 禁止事項

import してはいけないもの:

- `unpdf`
- `pdfjs-dist`
- `canvas`
- OCR libraries
- Discord libraries
- `tools/ingest` 内の code

request handler から CITサービスのページや PDF を取得してはいけません。

## 実行時の動作

route を KV key に対応させ、生成済み JSON 文字列をそのまま返します。

通常の成功 path では、大きな JSON document を parse しないでください。
