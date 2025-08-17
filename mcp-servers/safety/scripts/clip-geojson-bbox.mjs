// scripts/clip-geojson-bbox.mjs
import fs from "node:fs";

if (process.argv.length < 4) {
  console.error("Usage: node scripts/clip-geojson-bbox.mjs <in.geojson> <out.geojson> --bbox=minLon,minLat,maxLon,maxLat");
  process.exit(1);
}

const inPath = process.argv[2];
const outPath = process.argv[3];
const bboxArg = process.argv.find(a => a.startsWith("--bbox="));
if (!bboxArg) {
  console.error("Missing --bbox=minLon,minLat,maxLon,maxLat");
  process.exit(1);
}
const [minLon, minLat, maxLon, maxLat] = bboxArg.replace("--bbox=", "").split(",").map(Number);

const raw = JSON.parse(fs.readFileSync(inPath, "utf8"));
const feats = (raw.features || []).filter(f => {
  const c = f?.geometry?.coordinates;
  if (!Array.isArray(c) || c.length < 2) return false;
  const [lon, lat] = c;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
});

const out = { type: "FeatureCollection", features: feats };
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
console.log(`[clip] kept ${feats.length} features within bbox [${minLon},${minLat},${maxLon},${maxLat}]`);
