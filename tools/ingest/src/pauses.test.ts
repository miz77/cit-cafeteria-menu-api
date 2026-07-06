import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPausedOn, loadPausePeriods } from "./pauses";

describe("pause periods", () => {
  it("loads the repository pause config", async () => {
    await expect(loadPausePeriods()).resolves.toEqual([]);
  });

  it("matches inclusive pause boundaries", () => {
    const periods = [{ from: "2026-08-01", to: "2026-09-20", reason: "summer_break" }];

    expect(isPausedOn("2026-07-31", periods)).toBeNull();
    expect(isPausedOn("2026-08-01", periods)?.reason).toBe("summer_break");
    expect(isPausedOn("2026-09-20", periods)?.reason).toBe("summer_break");
    expect(isPausedOn("2026-09-21", periods)).toBeNull();
  });

  it("rejects malformed configs and invalid ranges", async () => {
    await expect(loadPausePeriods(await tempJson("{"))).rejects.toThrow("Failed to read pause periods");
    await expect(
      loadPausePeriods(await tempJson({ pausePeriods: [{ from: "2026-09-20", to: "2026-08-01", reason: "x" }] }))
    ).rejects.toThrow("from must be earlier than or equal to to");
    await expect(
      loadPausePeriods(await tempJson({ pausePeriods: [{ from: "2026-02-30", to: "2026-03-01", reason: "x" }] }))
    ).rejects.toThrow("Invalid calendar date");
  });
});

async function tempJson(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cit-cafeteria-pauses-"));
  const file = path.join(dir, "pauses.json");
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  return file;
}
