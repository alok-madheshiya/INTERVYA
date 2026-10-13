// Bundles transformers.js into one self-contained ESM file for use in Workers.
//
// Why this exists: import maps apply to the document only, never to a Worker.
// transformers.js ships bare imports ("onnxruntime-web/webgpu", which in turn
// pulls "onnxruntime-common"), so loading it inside a worker dies immediately
// with "Failed to resolve module specifier". Patching specifiers by hand is
// whack-a-mole across minified files; bundling resolves the whole graph once,
// with the correct browser conditions.
//
//   npm run build:vendor
//
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "vendor");

await mkdir(OUT, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, "node_modules/@huggingface/transformers/dist/transformers.web.js")],
  outfile: path.join(OUT, "transformers.bundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  // Node-only paths inside the library that must never be pulled into a browser
  // bundle. They sit behind runtime guards, so stubbing them is safe.
  external: ["sharp", "onnxruntime-node", "fs", "path", "url", "module", "worker_threads"],
  // onnxruntime fetches its .wasm at runtime from env.backends.onnx.wasm.wasmPaths,
  // so the binaries stay as separate files rather than being inlined.
  loader: { ".wasm": "file" },
  logLevel: "warning",
  metafile: true,
});

// The WASM binaries live next to the bundle so wasmPaths can point at /vendor/.
await cp(
  path.join(ROOT, "node_modules/onnxruntime-web/dist"),
  path.join(OUT, "ort"),
  { recursive: true, filter: (src) => !src.endsWith(".map") }
);

const [, info] = Object.entries(result.metafile.outputs)[0] ?? [];
console.log(`vendor/transformers.bundle.js  ${Math.round((info?.bytes ?? 0) / 1024)} KB`);
console.log("vendor/ort/                     onnxruntime wasm + js");
