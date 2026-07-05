import fs from "node:fs";
import path from "node:path";

const targetDir = process.argv[2];
const limitBytes = Number(process.argv[3] ?? "2621440");

if (!targetDir) {
  console.error("Usage: node scripts/check-worker-bundle.mjs <bundled-dir> <limit-bytes>");
  process.exit(2);
}

if (!fs.existsSync(targetDir)) {
  console.warn(`Bundle directory does not exist: ${targetDir}`);
  console.warn("Run wrangler deploy --dry-run --outdir bundled first.");
  process.exit(0);
}

let total = 0;
for (const file of fs.readdirSync(targetDir)) {
  const full = path.join(targetDir, file);
  if (fs.statSync(full).isFile()) total += fs.statSync(full).size;
}

console.log(`Approx bundled output size: ${total} bytes`);
console.log("Note: use Wrangler output as source of truth for gzip upload size.");

if (total > limitBytes) {
  console.error(`Bundle output exceeds hard limit: ${total} > ${limitBytes}`);
  process.exit(1);
}
