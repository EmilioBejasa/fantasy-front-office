#!/usr/bin/env node
// Builds the live site into dist/: the same files, except index.html's JSX is
// compiled and minified ahead of time and Tailwind is a prebuilt stylesheet,
// so visitors don't download Babel (~630KB) and the Tailwind Play CDN script
// or wait for them to run. index.html itself stays as it is, so it still works
// double-clicked, and the refresh scripts keep editing it in place.
//
// Usage: node scripts/build.js   (needs esbuild and tailwindcss installed;
// the deploy workflow runs `npm install --no-save esbuild tailwindcss` first)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const COPY = [
  ".nojekyll", "favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
  "og-image.png", "manifest.webmanifest", "data", "scripts/lib",
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST);
for (const f of COPY) fs.cpSync(path.join(ROOT, f), path.join(DIST, f), { recursive: true });

let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

// The JSX app, compiled the way Babel's react preset does it in the browser.
const babel = /<script type="text\/babel" data-presets="react">([\s\S]*?)<\/script>/;
const jsx = html.match(babel);
if (!jsx) throw new Error("Couldn't find the text/babel script in index.html");
// This deploy's id, for cache-busting the data files the page loads on demand.
const source = jsx[1].replace('const BUILD_ID = "dev";', `const BUILD_ID = "${Date.now().toString(36)}";`);
if (source === jsx[1]) throw new Error("Couldn't find BUILD_ID in index.html");
const { code } = esbuild.transformSync(source, { loader: "jsx", minify: true, target: "es2020" });
html = html.replace(babel, () => `<script>${code.replace(/<\/script/gi, "<\\/script")}</script>`);

// Cache-busting: local scripts get their content's hash in the URL.
const hash = (file) => crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, file))).digest("hex").slice(0, 10);
html = html.replace(/<script src="((?:scripts\/lib|data)\/[^"?]+\.js)"><\/script>/g, (m, file) => `<script src="${file}?v=${hash(file)}"></script>`);

// Drop the in-browser compilers.
for (const tag of [
  /<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\n?/,
  /<script src="https:\/\/unpkg\.com\/@babel\/standalone@[^"]+"[^>]*><\/script>\n?/,
]) {
  if (!tag.test(html)) throw new Error(`Couldn't find ${tag} in index.html`);
  html = html.replace(tag, "");
}

// Tailwind, built from the classes the page and its scripts use. Linked last
// in <head>, where the Play CDN injects its styles, so the cascade is the same.
const input = path.join(DIST, "tailwind.in.css");
fs.writeFileSync(input, "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n");
execFileSync(process.execPath, [
  require.resolve("tailwindcss/lib/cli.js"), "-i", input, "-o", path.join(DIST, "tailwind.css"), "--minify",
  "--content", `${path.join(ROOT, "index.html")},${path.join(ROOT, "scripts/lib/*.js")}`,
], { stdio: "inherit" });
fs.rmSync(input);
html = html.replace("</head>", '<link rel="stylesheet" href="tailwind.css" />\n</head>');

fs.writeFileSync(path.join(DIST, "index.html"), html);
console.log(`Built dist/index.html (${(html.length / 1024).toFixed(0)} KB) and dist/tailwind.css`);
