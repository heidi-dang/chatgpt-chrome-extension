import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(src, "manifest.json"), "utf8"));
const releaseVersion = packageJson.version;
const chromeVersionPattern = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;
if (
  typeof releaseVersion !== "string" ||
  !chromeVersionPattern.test(releaseVersion) ||
  releaseVersion.split(".").some((component) => Number(component) > 65535)
) {
  throw new Error(`Invalid Chrome extension release version: ${String(releaseVersion)}`);
}
manifest.version = releaseVersion;

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
  ["popup/popup.html", "popup.html"],
  ["options/options.html", "options.html"],
  ["ui.css", "ui.css"],
]) {
  await cp(resolve(src, input), resolve(dist, output));
}

await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Built CPTR Live Computer extension ${releaseVersion} in dist/`);
