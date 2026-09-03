import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = [
  ["background/service-worker.ts", "service-worker.js"],
  ["popup/popup.ts", "popup.js"],
  ["options/options.ts", "options.js"],
];

for (const [input, output] of entries) {
  await mkdir(dirname(resolve(dist, output)), { recursive: true });
  await build({
    entryPoints: [resolve(src, input)],
    outfile: resolve(dist, output),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    treeShaking: true,
  });
}

for (const [input, output] of [
  ["manifest.json", "manifest.json"],
  ["popup/popup.html", "popup.html"],
  ["options/options.html", "options.html"],
  ["ui.css", "ui.css"],
]) {
  await cp(resolve(src, input), resolve(dist, output));
}

console.log("Built CPTR Live Computer extension in dist/");
