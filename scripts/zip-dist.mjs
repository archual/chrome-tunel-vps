import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import archiver from "archiver";

const [archiveArg, sourceArg] = process.argv.slice(2);

if (!archiveArg || !sourceArg) {
  console.error("Usage: node scripts/zip-dist.mjs <archive.zip> <source-dir>");
  process.exit(1);
}

const archivePath = resolve(archiveArg);
const sourceDir = resolve(sourceArg);

const sourceStats = await stat(sourceDir).catch(() => null);
if (!sourceStats?.isDirectory()) {
  console.error(`Source directory does not exist: ${sourceDir}`);
  process.exit(1);
}

const output = createWriteStream(archivePath);
const archive = archiver("zip", { zlib: { level: 9 } });

const completed = new Promise((resolvePromise, rejectPromise) => {
  output.on("close", resolvePromise);
  output.on("error", rejectPromise);
  archive.on("warning", (error) => {
    if (error.code === "ENOENT") {
      console.warn(error.message);
      return;
    }
    rejectPromise(error);
  });
  archive.on("error", rejectPromise);
});

archive.pipe(output);
archive.directory(sourceDir, false, (entry) => {
  return basename(entry.name).endsWith(".zip") ? false : entry;
});
await archive.finalize();
await completed;

console.log(`Created ${archivePath}`);
