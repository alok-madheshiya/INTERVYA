// Downloads each company's real mark once, into assets/logos/, so the app
// never reaches the network to draw its own company grid.
//
// Run with: npm run build-logos
//
// Two favicon services are asked for every company and the larger answer wins,
// because neither covers the list on its own — measured on 2026-09-06, each
// had 33 of the 48, but not the same 33. simple-icons is the fallback after
// both, and a monogram tile in the UI is the fallback after that, so a failure
// here degrades rather than breaks.
//
// Result on that run: 47/48. Only Dream11 has no mark anywhere.
//
// The marks are trademarks of their owners and appear only to identify the
// company being practised for.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as simpleIcons from "simple-icons";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "assets", "logos");

// Where each company's favicon lives. A few are not the obvious domain — those
// are marked, because the obvious one was tried first and 404ed.
const DOMAINS = {
  tcs: "www.tcs.com", infosys: "infosys.com", wipro: "wipro.com",
  accenture: "accenture.com", cognizant: "cognizant.com", capgemini: "capgemini.com",
  hcltech: "hcltech.com", techmahindra: "techmahindra.com",
  ltimindtree: "ltimindtree.com", mphasis: "mphasis.com",
  amazon: "amazon.com", microsoft: "microsoft.com", google: "google.com",
  adobe: "adobe.com", atlassian: "atlassian.com", salesforce: "salesforce.com",
  oracle: "oracle.com", sap: "sap.com", cisco: "cisco.com",
  qualcomm: "qualcomm.com", nvidia: "nvidia.com", uber: "uber.com",
  flipkart: "flipkart.com", walmart: "walmart.com", phonepe: "phonepe.com",
  samsung: "samsung.com", zomato: "zomato.com", swiggy: "swiggy.com",
  razorpay: "razorpay.com", cred: "cred.club", zepto: "zeptonow.com",
  groww: "groww.in",
  meesho: "meesho.io",              // meesho.com has no icon; the .io does
  dream11: "dream11.com",           // no icon anywhere — expected to fall back
  sharechat: "sharechat.com", rapido: "rapido.bike", physicswallah: "pw.live",
  deloitte: "deloitte.com", ey: "ey.com", pwc: "pwc.com", kpmg: "kpmg.com",
  jpmc: "jpmorganchase.com", goldman: "goldmansachs.com",
  morganstanley: "morganstanley.com",
  optum: "unitedhealthgroup.com",   // optum.com has none; the parent does
  zs: "zs.com", barclays: "barclays.com", amex: "americanexpress.com",
};

// Last resort before the monogram. simple-icons ships a single-path SVG plus
// the brand hex — sharper than any favicon, but it only carries a fraction of
// this list, and its marks are flat where a favicon is in full colour.
const VECTOR = {
  tcs: "Tcs", infosys: "Infosys", wipro: "Wipro", accenture: "Accenture",
  hcltech: "Hcl", atlassian: "Atlassian", sap: "Sap", cisco: "Cisco",
  qualcomm: "Qualcomm", nvidia: "Nvidia", uber: "Uber", phonepe: "Phonepe",
  samsung: "Samsung", zomato: "Zomato", swiggy: "Swiggy", razorpay: "Razorpay",
  google: "Google", goldman: "Goldmansachs", barclays: "Barclays",
  amex: "Americanexpress",
};

// Both services answer an unknown domain with a 404, so `r.ok` already screens
// out their placeholder. The only thing left to reject is an empty body — an
// earlier 1000-byte floor here threw away real icons: Google serves a site's
// own favicon at its native size, and Cisco's is 201 bytes.
const MIN_BYTES = 100;

const EXT = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
};

async function grab(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < MIN_BYTES) return null;
  const ext = EXT[(r.headers.get("content-type") || "").split(";")[0].trim()];
  return ext ? { buf, ext } : null;
}

function vectorFor(id) {
  const key = VECTOR[id];
  const icon = key && simpleIcons["si" + key];
  if (!icon) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
              `<path fill="#${icon.hex}" d="${icon.path}"/></svg>`;
  return { buf: Buffer.from(svg, "utf8"), ext: "svg" };
}

const companies = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data", "companies.json"), "utf8")).companies;

fs.mkdirSync(OUT, { recursive: true });
const existing = new Map(fs.readdirSync(OUT).map((f) => [f.replace(/\.[^.]+$/, ""), f]));

const logos = {};
const missing = [];

for (const c of companies) {
  const domain = DOMAINS[c.id];
  let got = null, from = "";

  if (domain) {
    // Ask both and keep the larger file. These are rendered at ~34px, so the
    // one with more pixels behind it is the one that stays sharp; the services
    // disagree about which domains they have, and by how much.
    const [ddg, goo] = await Promise.all([
      grab(`https://icons.duckduckgo.com/ip3/${domain}.ico`),
      grab(`https://www.google.com/s2/favicons?sz=128&domain=${domain}`),
    ]);
    if (ddg && (!goo || ddg.buf.length >= goo.buf.length)) { got = ddg; from = "duckduckgo"; }
    else if (goo) { got = goo; from = "google"; }
  }
  if (!got) {
    got = vectorFor(c.id);
    if (got) from = "simple-icons";
  }

  if (!got) {
    // A build re-run on a bad connection must not delete a mark that a good
    // one already fetched.
    const kept = existing.get(c.id);
    if (kept) {
      logos[c.id] = kept;
      console.log(`  ..  ${c.id.padEnd(15)} fetch failed — keeping ${kept}`);
    } else {
      missing.push(c.id);
      console.log(`  --  ${c.id.padEnd(15)} no mark found — will show a monogram`);
    }
    continue;
  }
  // The extension can change between runs, so drop any stale copy first.
  const stale = existing.get(c.id);
  if (stale && stale !== `${c.id}.${got.ext}`) fs.unlinkSync(path.join(OUT, stale));

  const file = `${c.id}.${got.ext}`;
  fs.writeFileSync(path.join(OUT, file), got.buf);
  logos[c.id] = file;
  console.log(`  ok  ${c.id.padEnd(15)} ${String(got.buf.length).padStart(6)} B  ${from}`);
}

fs.writeFileSync(
  path.join(ROOT, "data", "logos.json"),
  JSON.stringify({
    note: "Company marks are the trademarks of their owners, used here only to " +
          "identify the company being practised for. Built by data/build-logos.mjs.",
    built_on: new Date().toISOString().slice(0, 10),
    logos,
  }, null, 2) + "\n"
);

console.log(`\n${Object.keys(logos).length}/${companies.length} marks written to assets/logos/`);
if (missing.length) console.log(`monogram fallback: ${missing.join(", ")}`);
