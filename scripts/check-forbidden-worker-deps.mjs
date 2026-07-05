import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = ["unpdf", "pdfjs-dist", "canvas", "tesseract.js", "sharp", "discord.js"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps/api-worker");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const offenders = [];
for (const file of walk(workerDir)) {
  const text = fs.readFileSync(file, "utf8");
  for (const pkg of forbidden) {
    if (text.includes(pkg)) offenders.push(`${file}: ${pkg}`);
  }
}

if (offenders.length) {
  console.error("Forbidden API Worker dependencies/references found:");
  console.error(offenders.join("\n"));
  process.exit(1);
}

console.log("No forbidden API Worker dependencies found.");
