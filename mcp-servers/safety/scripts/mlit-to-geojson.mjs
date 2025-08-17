// scripts/mlit-to-geojson.mjs
import fs from "node:fs";
import path from "node:path";

function toNumber(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function bboxToPolygon(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [minX, minY, maxX, maxY] = b.map(toNumber);
  if ([minX, minY, maxX, maxY].some(v => v === null)) return null;
  return {
    type: "Polygon",
    coordinates: [[
      [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]
    ]]
  };
}

function asArrayMaybeBBox(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    // try to parse "minX,minY,maxX,maxY"
    const parts = val.split(",").map(s => s.trim());
    if (parts.length === 4 && parts.every(p => !isNaN(Number(p)))) {
      return parts.map(Number);
    }
  }
  return null;
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// CLI args
const inPath  = process.argv[2] || "mlit-search-hinan.parsed.json";
const outPath = process.argv[3] || "data/hazards-tokyo.geojson";

// simple flags: --pref="東京都" --max=1000 --tag="避難施設"
const flags = Object.fromEntries(
  process.argv.slice(4).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
  })
);

const PREF_FILTER = (flags.pref || "").toString(); // e.g., 東京都
const MAX = Number(flags.max || 100000);
const EXTRA_TAG = flags.tag ? flags.tag.toString() : "";

const rows = loadJSON(path.resolve(inPath));
if (!Array.isArray(rows)) {
  console.error("[geo] Input is not an array:", inPath);
  process.exit(2);
}

let countKept = 0;
const features = [];

for (const r of rows) {
  if (PREF_FILTER && !(r.prefecture || "").includes(PREF_FILTER)) continue;

  const lat = toNumber(r.lat);
  const lon = toNumber(r.lon);
  const bboxArr = asArrayMaybeBBox(r.bbox);
  const polygon = bboxToPolygon(bboxArr);

  let geometry = null;
  if (lat !== null && lon !== null) {
    geometry = { type: "Point", coordinates: [lon, lat] };
  } else if (polygon) {
    geometry = polygon;
  } else {
    // skip if we can’t place it on a map
    continue;
  }

  const props = {
    name: r.name || "",
    description: r.description || "",
    publisher: r.publisher || "",
    datasetId: r.datasetId || "",
    dataId: r.dataId || "",
    prefecture: r.prefecture || "",
    municipality: r.municipality || "",
    updatedAt: r.updatedAt || "",
    fileUrl: r.fileUrl || "",
    source: "MLIT",
  };
  if (EXTRA_TAG) props.tags = [EXTRA_TAG];

  features.push({ type: "Feature", properties: props, geometry });
  countKept++;
  if (countKept >= MAX) break;
}

const fc = { type: "FeatureCollection", features };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(fc, null, 2), "utf8");

console.log(`[geo] input:  ${inPath}`);
console.log(`[geo] kept:   ${features.length} (pref="${PREF_FILTER || "(none)"}")`);
console.log(`[geo] output: ${outPath}`);
