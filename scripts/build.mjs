import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const entries = [
  ["background/service-worker.ts", "service-worker.js"],
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

await cp(resolve(src, "manifest.json"), resolve(dist, "manifest.json"));

for (const page of ["popup", "options"]) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPTR Live Computer</title></head><body><main><h1>CPTR Live Computer</h1><p>Device pairing UI is being connected to the background coordinator.</p></main></body></html>`;
  await writeFile(resolve(dist, `${page}.html`), html, "utf8");
}

console.log("Built CPTR Live Computer extension in dist/");
