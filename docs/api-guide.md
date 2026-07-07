# API Guide

この API は、CITサービスが公開している学食メニュー PDF から生成した JSON を返します。
生成メニューデータを MIT License の対象とは説明しません。

## 最小例

```bash
curl -s "https://cit-cafeteria-menu-api.miz77.workers.dev/api/v1/locations/tsudanuma/menus/today"
```

```js
const baseUrl = "https://cit-cafeteria-menu-api.miz77.workers.dev";
const response = await fetch(`${baseUrl}/api/v1/locations/tsudanuma/menus/today`);
if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

const { location } = await response.json();

if (location.status !== "ok") {
  console.log(`${location.name}: ${location.status}`);
} else {
  let lines = location.menuText.lines;
  if (location.menuItems.length > 0) {
    lines = location.menuItems.map((item) => {
      const price = item.priceYen == null ? "" : ` ${item.priceYen}円`;
      return `${item.name}${price}`;
    });
  }

  console.log(lines.join("\n"));
}
```

`today` と `week` は `Asia/Tokyo` 基準です。食堂 ID は `tsudanuma`, `shinnarashino-1f`, `shinnarashino-2f` です。

長期休業中、メニュー未公開期間、または対象日の JSON がまだ生成されていない場合、メニュー endpoint は 404 を返すことがあります。

## メニュー項目

- `menuItems`: メニュー名に価格とカテゴリを安全に紐づけた項目だけを含みます。順序は PDF 上の見た目順です。
- `unassignedLines`: 安全に構造化できなかった原文行です。告知文、営業時間凡例、曖昧な断片などが入ります。
- `menuText.lines`: PDF から抽出した元の行です。構造化できないときの簡易表示やデバッグに使えます。
- `priceYen`: 円単位の整数価格です。価格を安全に取得できない場合は `null` です。
- `priceText`: `<工大350>` や `¥350` など、PDF 上の価格表記です。取得できない場合は `null` です。
- `categoryLabel`: PDF 上のカテゴリ・行ラベルです。不明な場合は `null` です。
- `statusMessage`: デバッグ用です。表示分岐には `status` enum を使ってください。

値が存在しない、または不明な場合は `null` を使います。必須フィールドは省略しません。

## Health

`/api/v1/health` は、最後に実行された ingest/update の結果を返します。各メニューエンドポイントが現在利用可能かどうかを直接表すものではありません。

たとえば定期更新に失敗して `health.status` が `failed` になっていても、過去に生成された KV データが残っていればメニューエンドポイントは HTTP 200 を返すことがあります。アプリ表示ではメニューエンドポイントのレスポンスを見て、`health` は運用・デバッグ情報として扱ってください。

## Confidence

- `0.9`: マーカーまたは行ラベルに基づく、強いレイアウト根拠のある構造化です。
- `0.6`: 価格行やブロック分割によるフォールバックです。利用できますが、カテゴリは通常 `unknown` です。
- `0.3`: 将来の弱いフォールバック用に予約しています。クライアント側では注意付き表示として扱ってください。

## Warnings

- `price_not_found`: メニュー名は見えていますが、価格を紐づけられませんでした。
- `category_unknown`: 既知カテゴリに分類できませんでした。
- `name_may_be_incomplete`: 表示名にカテゴリ文脈を足した方がよい可能性があります。

例: `categoryLabel: "ラーメン"` かつ `name: "味噌"` の場合、`味噌` だけでなく `ラーメン（味噌）` のように表示すると分かりやすくなります。

## クライアント実装メモ

### Swiftで未知のcategoryを受ける

将来 enum 値が増えても落ちないようにしてください。

```swift
enum MenuCategory: Codable, Equatable {
    case asaTeishoku, koudaiTeishoku, yuTeishoku, teishoku
    case higawariSalad, gourmetCurry, donburi, curry
    case menCorner, keishokuPasta, sideDish
    case unknown(String)

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "asa_teishoku": self = .asaTeishoku
        case "koudai_teishoku": self = .koudaiTeishoku
        case "yu_teishoku": self = .yuTeishoku
        case "teishoku": self = .teishoku
        case "higawari_salad": self = .higawariSalad
        case "gourmet_curry": self = .gourmetCurry
        case "donburi": self = .donburi
        case "curry": self = .curry
        case "men_corner": self = .menCorner
        case "keishoku_pasta": self = .keishokuPasta
        case "side_dish": self = .sideDish
        default: self = .unknown(raw)
        }
    }
}
```

enum 値の追加は minor change として扱います。既存値の削除・改名は v2 API が必要です。
