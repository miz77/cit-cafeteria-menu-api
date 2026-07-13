import { describe, expect, it } from "vitest";
import { parseSharedPricePairs } from "./sharedPriceTokens";

describe("shared price tokens", () => {
  it("normalizes yen markers and combines split full-width digits", () => {
    expect(parseSharedPricePairs(["唐揚￥１", "5", "０"])).toEqual([
      {
        name: "唐揚",
        priceYen: 150,
        nameTokenIndex: 0,
        priceTokenIndexes: [0, 1, 2],
        consumedTokenIndexes: [0, 1, 2]
      }
    ]);
  });

  it("supports the PDF backslash form without interpreting unrelated text", () => {
    expect(parseSharedPricePairs(["ライス\\", "100"])[0]).toMatchObject({ name: "ライス", priceYen: 100 });
    expect(parseSharedPricePairs(["注記", "100"])).toEqual([]);
  });

  it("rejects incomplete and implausibly long prices", () => {
    expect(parseSharedPricePairs(["味噌汁￥"])).toEqual([]);
    expect(parseSharedPricePairs(["ライス￥", "123456"])).toEqual([]);
  });
});
