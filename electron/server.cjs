// A tiny loopback static server for the renderer.
//
// Why not a custom app:// protocol? WebGPU needs a secure context, which app://
// can provide — but a custom scheme also gives every cross-origin download
// (Ready Player Me GLBs, HuggingFace model weights, onnxruntime WASM) a CORS
// origin that CDNs don't expect, and they fail with a bare "Failed to fetch".
// http://127.0.0.1 is treated as a secure context by browsers *and* behaves like
// a normal origin, which is what three.js / transformers.js are tested against.
const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".onnx": "application/octet-stream",
  ".onnx_data": "application/octet-stream",
};

/**
 * Downloads a remote asset through Node (no CORS involved at all) and caches it
 * on disk, so the second run is fully offline. This is how avatars get in.
 */
async function cachedFetch(remoteUrl, cacheDir) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const key = crypto.createHash("sha1").update(remoteUrl).digest("hex").slice(0, 16);
  const ext = path.extname(new URL(remoteUrl).pathname) || ".bin";
  const file = path.join(cacheDir, key + ext);

  try {
    const buf = await fsp.readFile(file);
    return { buf, ext, cached: true };
  } catch {
    /* not cached yet */
  }

  let res;
  try {
    res = await fetch(remoteUrl, { redirect: "follow" });
  } catch (e) {
    // Node's fetch reports every network failure as a bare "fetch failed"; the
    // actual reason (ENOTFOUND, ECONNREFUSED, TLS) only lives on err.cause.
    const cause = e?.cause;
    throw new Error(
      `network: ${e.message}` +
      (cause ? ` (${cause.code || cause.name || ""} ${cause.message || ""})`.trimEnd() : "")
    );
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${remoteUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(file, buf);
  return { buf, ext, cached: false };
}

// CacheStorage is keyed by origin, and the origin includes the port — so a new
// port every launch hands transformers.js an empty cache, re-downloads every
// model, and strands the old cache with nothing left to evict it. Holding one
// port keeps those weights warm across launches.
const PREFERRED_PORT = 41999;

/**
 * @returns {Promise<{origin: string, port: number, close: () => void}>}
 */
function startServer({ root, cacheDir, logRequests = false }) {
  const server = http.createServer(async (req, res) => {
    // Model loading is the one place where a silent 404 costs a minute of
    // startup: transformers.js quietly falls back to huggingface.co instead of
    // failing, so a wrong local filename looks like "the network is slow".
    if (logRequests) {
      const t0 = Date.now();
      res.on("finish", () => {
        const p = req.url.split("?")[0];
        if (res.statusCode !== 200 || p.startsWith("/models/")) {
          console.log(`[req] ${String(res.statusCode).padEnd(4)} ${Date.now() - t0}ms  ${p}`);
        }
      });
    }

    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end("bad url");
      return;
    }

    // /_asset?url=<remote> — proxy + disk cache. Lets the renderer pull a Ready
    // Player Me avatar without ever making a cross-origin request itself.
    if (url.pathname === "/_asset") {
      const remote = url.searchParams.get("url");
      if (!remote || !/^https:\/\//.test(remote)) {
        res.writeHead(400).end("url param must be https");
        return;
      }
      try {
        const { buf, ext, cached } = await cachedFetch(remote, cacheDir);
        res.writeHead(200, {
          "Content-Type": TYPES[ext] || "application/octet-stream",
          "Content-Length": buf.length,
          "X-Cache": cached ? "HIT" : "MISS",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(502, { "Content-Type": "text/plain" }).end(String(e.message || e));
      }
      return;
    }

    // /_diag — checks every host the app depends on, from the main process, and
    // reports the real error for each. Beats guessing at "fetch failed".
    if (url.pathname === "/_diag") {
      const targets = {

        "huggingface.co (models)": "https://huggingface.co/api/models/onnx-community/whisper-base.en",
        "hf cdn (weights)": "https://cdn-lfs.hf.co/",
        "raw.githubusercontent (avatar mirror)":
          "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/README.md",

        "generativelanguage (gemini)": "https://generativelanguage.googleapis.com/",
      };
      // Three attempts per host: a domain that fails every time is blocked,
      // one that fails intermittently is just a flaky link — very different fixes.
      const ATTEMPTS = 3;
      const report = {};
      await Promise.all(
        Object.entries(targets).map(async ([label, u]) => {
          const t0 = Date.now();
          let okCount = 0, status = null, last = null;
          for (let i = 0; i < ATTEMPTS; i++) {
            try {
              const r = await fetch(u, { method: "GET", redirect: "follow" });
              okCount++;
              status = r.status;
            } catch (e) {
              const c = e?.cause;
              last = {
                error: e.message,
                code: c?.code || c?.name || null,
                detail: c?.message || null,
              };
            }
          }
          report[label] = {
            ok: okCount > 0,
            flaky: okCount > 0 && okCount < ATTEMPTS,
            tries: `${okCount}/${ATTEMPTS}`,
            status,
            ms: Date.now() - t0,
            ...(okCount === ATTEMPTS ? {} : last || {}),
          };
        })
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report, null, 2));
      return;
    }

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const target = path.join(root, rel);
    if (!target.startsWith(root)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("not found: " + rel);
        return;
      }

      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Content-Length": stat.size,
        // Deliberately no COEP/COOP: they would enable threaded WASM for
        // onnxruntime, but they also block every cross-origin subresource that
        // lacks CORP — including HuggingFace weights. WebGPU is available here,
        // so the threaded-WASM fallback isn't worth that cost.
      });
      fs.createReadStream(target).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    const settle = () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        port,
        close: () => server.close(),
      });
    };

    // EADDRINUSE means a second copy already holds the port, so fall back to an
    // OS-assigned one rather than refusing to start — that copy loads cold, but
    // two copies never collide and the usual single-instance case stays warm.
    server.once("error", (err) => {
      if (err.code !== "EADDRINUSE") return reject(err);
      server.once("error", reject);
      server.listen(0, "127.0.0.1", settle);
    });
    server.listen(PREFERRED_PORT, "127.0.0.1", settle);
  });
}

module.exports = { startServer };
