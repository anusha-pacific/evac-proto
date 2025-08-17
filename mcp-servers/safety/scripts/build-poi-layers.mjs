// scripts/build-poi-layers.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- config ----
const INPUT_JSON = path.join(process.cwd(), "mlit-search-hinan.parsed.json");
const INPUT_CSV  = path.join(process.cwd(), "mlit-search-hinan.parsed.csv");
const DATA_DIR   = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- tiny utils ----
const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const asFC = (features) => ({ type: "FeatureCollection", features });

function writeFC(p, fc) {
  fs.writeFileSync(p, JSON.stringify(fc, null, 2), "utf8");
}

function dedupe(features) {
  const seen = new Map();
  for (const f of features) {
    const id = f.properties.dataId || `${f.properties.name}|${f.geometry.coordinates.join(",")}`;
    if (!seen.has(id)) seen.set(id, f);
  }
  return [...seen.values()];
}

// Simple CSV parser handling quotes and commas in names
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = splitCSVLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const pick = (k) => {
      const j = idx[k];
      return j == null ? "" : cols[j] ?? "";
    };
    rows.push({
      name: pick("name").trim(),
      description: pick("description").trim(),
      publisher: pick("publisher").trim(),
      datasetId: pick("datasetId").trim(),
      dataId: pick("dataId").trim(),
      prefecture: pick("prefecture").trim(),
      municipality: pick("municipality").trim(),
      updatedAt: pick("updatedAt").trim(),
      lat: toNum(pick("lat")),
      lon: toNum(pick("lon")),
      bbox: pick("bbox").trim(),
      fileUrl: pick("fileUrl").trim(),
    });
  }
  return rows;
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const toNum = (v) => (v === "" || v == null ? null : Number(v));

// ---- classification ----
function classifyTags(name) {
  const n = (name || "").trim();

  // Exclusions (memorials, tenders, models)
  const isMemorial = /(記念碑|慰霊|震災記念|復興記念|復旧記念|私たちは忘れない)/.test(n);
  const isTender  = /(令和|平成).*(業務|工事|改修|除雪|計画|検討|委託|事業)/.test(n);
  const isModel   = /(3D都市モデル|PLATEAU)/i.test(n);
  const isMonument= /(碑$)/.test(n);
  if (isMemorial || isTender || isModel || isMonument) return { keep:false, tags:[], primary:null };

  const tags = [];

  // --- Shelters (match ALL common variants) ---
  // first: if it’s any kind of 避難… treat as shelter
  const isShelter =
    /避難所|避難施設|緊急避難施設|集合避難施設|津波.*避難|災害.*避難|防災拠点.*避難所?/.test(n) ||
    /福祉避難所/.test(n); // welfare shelter
  if (isShelter) tags.push("shelter");

  // --- Schools ---
  if (/(小学校|中学校|高校|高等学校|大学|義務教育学校|保育園|幼稚園|こども園)/.test(n)) {
    tags.push("school");
  }

  // --- Health/medical (but NOT when it’s a shelter) ---
  // Guard so 保健センター/保健福祉センター that also say 避難所 do NOT become "health".
  const mentionsShelter = /避難所|避難施設/.test(n);
  const isHealthCore = /(病院|医院|クリニック|医療センター|医療機関)/.test(n);
  const isHealthGov  = /(保健センター|保健福祉センター|保健所)/.test(n);
  if (!mentionsShelter && (isHealthCore || isHealthGov)) {
    tags.push("health");
  }

  // --- Civic/public buildings (fallback-ish) ---
  if (/(公民館|集会所|会館|体育館|地域センター|コミュニティセンター|社会福祉協議会|市役所|区役所)/.test(n)) {
    tags.push("civic");
  }

  // --- Retail (rare in this slice) ---
  if (/(ショッピング|スーパー|商店|市場|コンビニ|ドラッグストア|薬局)/.test(n)) {
    tags.push("shop");
  }

  // Generic civic-y fallback if nothing else hit
  if (/(センター|館|会館|地区|地域)/.test(n) && tags.length === 0) {
    tags.push("civic");
  }

  if (tags.length === 0) return { keep:true, tags:["other"], primary:"other" };

  // Priority: shelter first, then school, then health
  const order = ["shelter","school","health","shop","civic","other"];
  const primary = order.find(t => tags.includes(t)) || tags[0];
  return { keep:true, tags, primary };
}


function toFeature(rec, tags, primary) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [rec.lon, rec.lat] },
    properties: {
      name: rec.name,
      primary,                // e.g., "shelter"
      tags,                   // e.g., ["shelter","health"]
      dataId: rec.dataId || null,
      municipality: rec.municipality || null,
      prefecture: rec.prefecture || null,
      source: "MLIT",
    }
  };
}

// ---- load input (JSON + CSV) ----
function loadInput() {
  const all = [];

  if (fs.existsSync(INPUT_JSON)) {
    const arr = readJSON(INPUT_JSON);
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (!isFinite(r?.lat) || !isFinite(r?.lon)) continue;
        all.push({
          name: r.name ?? "",
          description: r.description ?? "",
          publisher: r.publisher ?? "",
          datasetId: r.datasetId ?? "",
          dataId: r.dataId ?? "",
          prefecture: r.prefecture ?? "",
          municipality: r.municipality ?? "",
          updatedAt: r.updatedAt ?? "",
          lat: Number(r.lat),
          lon: Number(r.lon),
          bbox: r.bbox ?? "",
          fileUrl: r.fileUrl ?? "",
        });
      }
    }
  }

  if (fs.existsSync(INPUT_CSV)) {
    const text = fs.readFileSync(INPUT_CSV, "utf8");
    const rows = parseCSV(text);
    for (const r of rows) {
      if (!isFinite(r?.lat) || !isFinite(r?.lon)) continue;
      all.push(r);
    }
  }

  // filter obviously invalid
  const valid = all.filter(r =>
    Number.isFinite(r.lat) &&
    Number.isFinite(r.lon) &&
    r.lat >= -90 && r.lat <= 90 &&
    r.lon >= -180 && r.lon <= 180 &&
    (r.name ?? "").toString().trim() !== ""
  );

  // dedupe input rows by dataId or name+coords
  const seen = new Map();
  for (const r of valid) {
    const key = r.dataId || `${r.name}|${r.lat},${r.lon}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

// ---- main ----
function main() {
  const rows = loadInput();

  const buckets = {
    shelter: [],
    school: [],
    health: [],
    hospital: [], // alias of health (for back-compat)
    shop: [],
    civic: [],
    other: [],
  };
  const excluded = [];

  for (const r of rows) {
    const c = classifyTags(r.name);
    if (!c.keep) { excluded.push(r); continue; }
    const feat = toFeature(r, c.tags, c.primary);
    // primary bucket
    buckets[c.primary].push(feat);
    // ensure health layer includes any health-tagged item even if primary is shelter
    //if (c.tags.includes("health")) buckets.health.push(feat);
  }
  // hospital alias = health
  buckets.hospital = buckets.health.slice();

  // dedupe features inside each layer
  for (const k of Object.keys(buckets)) buckets[k] = dedupe(buckets[k]);

  // write all layers
  const out = (name, fc) => writeFC(path.join(DATA_DIR, name), asFC(fc));
  out("shelters.geojson",  buckets.shelter);
  out("schools.geojson",   buckets.school);
  out("health.geojson",    buckets.health);
  out("hospitals.geojson", buckets.hospital);
  out("shops.geojson",     buckets.shop);
  out("civic.geojson",     buckets.civic);
  out("others.geojson",    buckets.other);

  fs.writeFileSync(
    path.join(DATA_DIR, "excluded.log.json"),
    JSON.stringify(excluded.slice(0, 500), null, 2),
    "utf8"
  );

  // console summary
  const counts = Object.fromEntries(Object.entries(buckets).map(([k,v]) => [k, v.length]));
  console.log("POI layers written to ./data");
  console.table(counts);
  console.log(`Excluded (non-POI): ${excluded.length}`);
}

// ---- run ----
main();
