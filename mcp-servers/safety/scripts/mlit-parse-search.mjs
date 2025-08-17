// scripts/mlit-parse-search.mjs
import fs from "node:fs";
import path from "node:path";

// Heuristics to pull common, readable fields from polymorphic MLIT objects.
function pickReadable(o) {
  const flat = (obj, prefix = "", out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
      else out[key] = v;
    }
    return out;
  };

  const f = flat(o);

  // Try a bunch of likely fields; fall back gracefully if missing.
  const name =
    f.title || f.name || f.datasetName || f.dataName || f["data.title"] || f["dataset.title"] || "";
  const description =
    f.description || f["data.description"] || f["dataset.description"] || "";
  const publisher =
    f.publisher || f["publisher.name"] || f["dataset.publisher"] || "";
  const datasetId =
    f.datasetId || f["dataset.id"] || f["datasetInfo.id"] || "";
  const dataId =
    f.dataId || f.id || f["data.id"] || "";
  const updatedAt =
    f.updatedAt || f.updateDate || f.modified || f["data.updatedAt"] || "";
  const prefecture = f.prefecture || f["location.prefecture"] || "";
  const municipality = f.municipality || f["location.municipality"] || "";

  // Try to surface a downloadable/file-ish URL if present
  const fileUrl =
    f.url ||
    f.downloadUrl ||
    f["file.url"] ||
    f["files.0.url"] ||
    f["thumbnail.url"] ||
    "";

  // Geo hints (very schema-dependent, so keep best-effort)
  const lat = f.lat || f.latitude || f["geom.lat"] || "";
  const lon = f.lon || f.longitude || f["geom.lon"] || "";
  const bbox =
    f.bbox ||
    f.boundingBox ||
    f["geometry.bbox"] ||
    "";

  return {
    name,
    description,
    publisher,
    datasetId,
    dataId,
    prefecture,
    municipality,
    updatedAt,
    lat,
    lon,
    bbox,
    fileUrl
  };
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toCSV(rows) {
  const headers = Object.keys(rows[0] || {});
  const esc = (s) =>
    s == null
      ? ""
      : String(s).includes(",") || String(s).includes('"') || String(s).includes("\n")
      ? `"${String(s).replace(/"/g, '""')}"`
      : String(s);
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

const inPath = process.argv[2] || "mlit-search-hinan.json";
const outJson = process.argv[3] || "mlit-search-hinan.parsed.json";
const outCsv  = process.argv[4] || "mlit-search-hinan.parsed.csv";

const raw = loadJSON(path.resolve(inPath));

// Your earlier script writes the raw search object, which should have { totalNumber, searchResults }
const results = raw?.searchResults || raw?.results || raw || [];
if (!Array.isArray(results)) {
  console.error("[parse] Could not find an array of results in", inPath);
  process.exit(2);
}

const parsed = results.map(pickReadable);

// Light de-duplication by (dataId || name)
const seen = new Set();
const deduped = parsed.filter(r => {
  const key = r.dataId || r.name || JSON.stringify(r);
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Example optional filter: Tokyo-only or has geo
// const filtered = deduped.filter(r => (r.prefecture.includes("東京") || r.municipality.includes("東京")) && (r.lat && r.lon));
const filtered = deduped;

fs.writeFileSync(outJson, JSON.stringify(filtered, null, 2), "utf8");
fs.writeFileSync(outCsv, toCSV(filtered), "utf8");

console.log(`[parse] input:  ${inPath}`);
console.log(`[parse] output: ${outJson} (${filtered.length} rows)`);
console.log(`[parse] output: ${outCsv}  (${filtered.length} rows)`);
