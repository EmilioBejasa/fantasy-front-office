// Loads index.html's app script into a Node vm with just enough of a browser
// stubbed in (window, document, localStorage, a React that never renders), so
// tests can call the page's own functions: the trade formula, IR return
// weeks, standings odds and so on. Nothing is copied out of index.html, so
// the tests always run the code the site ships.
//
// Needs esbuild (the same version scripts/build.js uses):
//   npm install --no-save --no-package-lock esbuild@0.24.0

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

function storage() {
  const items = new Map();
  return {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
    clear: () => items.clear(),
  };
}

function loadApp() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const jsx = /<script type="text\/babel" data-presets="react">([\s\S]*?)<\/script>/.exec(html);
  if (!jsx) throw new Error("Couldn't find the text/babel script in index.html");
  const { code } = esbuild.transformSync(jsx[1], { loader: "jsx", target: "es2020" });

  const noop = () => {};
  const element = () => ({ appendChild: noop, addEventListener: noop, removeEventListener: noop, setAttribute: noop, style: {}, dataset: {} });
  const React = {
    createElement: () => null,
    Fragment: "Fragment",
    createContext: (value) => ({ Provider: "Provider", _value: value }),
    Component: class {},
    useState: (v) => [typeof v === "function" ? v() : v, noop],
    useMemo: (f) => f(), useRef: (v) => ({ current: v }), useEffect: noop, useLayoutEffect: noop,
    useContext: (c) => c._value, useCallback: (f) => f,
  };
  const sandbox = {
    React,
    ReactDOM: { createRoot: () => ({ render: noop }) },
    localStorage: storage(),
    sessionStorage: storage(),
    location: { hash: "", href: "http://localhost/" },
    history: { replaceState: noop, pushState: noop },
    navigator: { userAgent: "node" },
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop, removeEventListener: noop,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: () => Promise.reject(new Error("no network in tests")),
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById: element, createElement: element, querySelector: () => null,
    head: element(), body: element(), documentElement: element(),
    addEventListener: noop, removeEventListener: noop, visibilityState: "visible",
  };
  const context = vm.createContext(sandbox);

  // The plain <script> libraries the page loads before its app script.
  for (const lib of ["sleeper-scores", "fantasycalc", "sleeper-nba", "sleeper-players", "dynasty-daddy"]) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, "scripts/lib", `${lib}.js`), "utf8"), context, { filename: `${lib}.js` });
  }
  vm.runInContext(code, context, { filename: "index.html" });

  // Top-level consts live in the context's global scope, so a later script can read them by name.
  return new Proxy({}, {
    get: (_, name) => vm.runInContext(`typeof ${String(name)} === "undefined" ? undefined : ${String(name)}`, context),
  });
}

module.exports = { loadApp, ROOT };
