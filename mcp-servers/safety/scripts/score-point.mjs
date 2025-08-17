#!/usr/bin/env node
/**
 * score-point.mjs
 * Usage: node scripts/score-point.mjs <lon> <lat> [radiusMeters=1500] [--list[=10]] [--debug]
 */
import fs from "node:fs";
import path from "node:path";

if (process.argv.length < 4) {
  console.error("Usage: node scripts/score-point.mjs <lon> <lat> [radius=1500] [--list[=10]] [--debug]");
  process.exit(1);
}

let lon = Number(process.argv[2]);
let lat = Number(process.argv[3]);
const radiusMeters = Number(process.argv[4] ?? 1500);
const listFlag = process.argv.find(a => a.startsWith("--list"));
const listLimit = listFlag
  ? (listFlag.includes("=") ? Number(listFlag.split("=")[1]) : 10)
  : 0;
const DEBUG = process.argv.includes("--debug");

const DATA_DIR = path.resolve(process.cwd(), "data");

// ------------------ geo helpers ------------------
const inJapan = (LON, LAT) => LON >= 122 && LON <= 154 && LAT >= 20 && LAT <= 46;
const toRad = d => d * Math.PI / 180;
const haversine = (lat1, lon1, lat2, lon2) => {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

// Auto-swap if user gave <lat lon>
if (!inJapan(lon, lat) && inJapan(lat, lon)) {
  const o = { lon, lat };
  [lon, lat] = [lat, lon];
  console.error(`Note: your inputs looked like <lat lon>. Auto-swapped to <lon lat>: ${o.lon}, ${o.lat} -> ${lon}, ${lat}`);
}

// ------------------ IO helpers ------------------
function loadGeoJSON(rel) {
  const file = path.join(DATA_DIR, rel);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  const gj = JSON.parse(raw);
  return { file, gj };
}
function featuresOf(gj) {
  if (!gj) return [];
  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) return gj.features;
  if (Array.isArray(gj)) return gj;
  return [];
}
function getLonLat(feat) {
  const g = feat?.geometry;
  if (g?.type === "Point" && Array.isArray(g.coordinates)) {
    let [x,y] = g.coordinates;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (!inJapan(x,y) && inJapan(y,x)) return { lon: y, lat: x, swapped: true };
      return { lon: x, lat: y, swapped: false };
    }
  }
  const p = feat?.properties ?? {};
  const cands = [
    [p.lon, p.lat], [p.LON, p.LAT], [p.longitude, p.latitude], [p.x, p.y]
  ];
  for (const [x,y] of cands) {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (!inJapan(x,y) && inJapan(y,x)) return { lon: y, lat: x, swapped: true };
      return { lon: x, lat: y, swapped: false };
    }
  }
  return null;
}
function nameOf(f) {
  const p = f?.properties ?? {};
  return (
    p.name ?? p.NAME ?? p.Name ?? p.title ?? p.school_name ??
    p.施設名 ?? p.名称 ?? "unknown"
  );
}

// ------------------ load categories ------------------
// We treat:
// - shelters: data/shelters.geojson
// - schools:  data/schools.geojson
// - health:   data/health.geojson + data/hospitals.geojson (merged if both exist)
const catFiles = {
  shelter: "shelters.geojson",
  school: "schools.geojson",
  healthA: "health.geojson",
  healthB: "hospitals.geojson"
};

const cats = {
  shelter: loadGeoJSON(catFiles.shelter),
  school: loadGeoJSON(catFiles.school),
  healthA: loadGeoJSON(catFiles.healthA),
  healthB: loadGeoJSON(catFiles.healthB)
};

const feats = {
  shelter: featuresOf(cats.shelter?.gj),
  school: featuresOf(cats.school?.gj),
  // merge health/hospitals
  health: [...featuresOf(cats.healthA?.gj), ...featuresOf(cats.healthB?.gj)]
};

// ------------------ do the search ------------------
function analyzeCategory(categoryName, features, origin, radius) {
  const inside = [];
  let nearest = null;
  let nearestD = Infinity;

  for (const f of features) {
    const ll = getLonLat(f);
    if (!ll) continue;
    const d = haversine(origin.lat, origin.lon, ll.lat, ll.lon);
    if (d < nearestD) {
      nearestD = d;
      nearest = { name: nameOf(f), distance_m: Math.round(d), lon: ll.lon, lat: ll.lat };
    }
    if (d <= radius) {
      inside.push({ name: nameOf(f), distance_m: Math.round(d), lon: ll.lon, lat: ll.lat });
    }
  }

  inside.sort((a,b) => a.distance_m - b.distance_m);
  return { count: inside.length, nearest, items: inside };
}

const origin = { lon, lat };
const resShelter = analyzeCategory("shelter", feats.shelter, origin, radiusMeters);
const resSchool  = analyzeCategory("school",  feats.school,  origin, radiusMeters);
const resHealth  = analyzeCategory("health",  feats.health,  origin, radiusMeters);

// ------------------ scoring ------------------
// Weight per category (tweak as you like)
const W = { shelter: 0.5, school: 0.3, health: 0.2 };
// Target counts within radius (cap contribution at 1.0)
const TARGET = { shelter: 2, school: 3, health: 2 };
// Distance decay (meters) for proximity bonus; larger = slower decay
const DECAY = { shelter: 1200, school: 1000, health: 1500 };

function subScore(result, cat) {
  // count contribution
  const countPart = Math.min(1, result.count / TARGET[cat]);

  // proximity contribution: exp(-d/DECAY)
  const d = result.nearest?.distance_m ?? Infinity;
  const proxPart = Number.isFinite(d) ? Math.exp(-d / DECAY[cat]) : 0;

  // blend count 70% / proximity 30%
  const blended = 0.7 * countPart + 0.3 * proxPart;
  return blended * W[cat];
}

const score =
  subScore(resShelter, "shelter") +
  subScore(resSchool, "school") +
  subScore(resHealth, "health");

// ------------------ output ------------------
const output = {
  shelters: { count: resShelter.count, nearest: resShelter.nearest },
  schools:  { count: resSchool.count,  nearest: resSchool.nearest },
  health:   { count: resHealth.count,   nearest: resHealth.nearest },
  score: Math.round(score * 100) / 100,
  params: { lon, lat, radiusMeters }
};

if (listLimit > 0) {
  output.nearby = {
    shelters: resShelter.items.slice(0, listLimit),
    schools:  resSchool.items.slice(0, listLimit),
    health:   resHealth.items.slice(0, listLimit)
  };
}

if (DEBUG) {
  output._diagnostics = {
    shelter: {
      file: cats.shelter?.file ? path.relative(process.cwd(), cats.shelter.file) : null,
      features: feats.shelter.length,
      pointGeoms: feats.shelter.length,
      fixedOrder: 0,
      samples: feats.shelter.slice(0,3).map(f => {
        const ll = getLonLat(f);
        return { name: nameOf(f), lon: ll?.lon, lat: ll?.lat, fixed: false };
      })
    },
    school: {
      file: cats.school?.file ? path.relative(process.cwd(), cats.school.file) : null,
      features: feats.school.length,
      pointGeoms: feats.school.length,
      fixedOrder: 0,
      samples: feats.school.slice(0,3).map(f => {
        const ll = getLonLat(f);
        return { name: nameOf(f), lon: ll?.lon, lat: ll?.lat, fixed: false };
      })
    },
    health: {
      files: [
        cats.healthA?.file ? path.relative(process.cwd(), cats.healthA.file) : null,
        cats.healthB?.file ? path.relative(process.cwd(), cats.healthB.file) : null
      ].filter(Boolean),
      features: feats.health.length,
      pointGeoms: feats.health.length,
      fixedOrder: 0,
      samples: feats.health.slice(0,3).map(f => {
        const ll = getLonLat(f);
        return { name: nameOf(f), lon: ll?.lon, lat: ll?.lat, fixed: false };
      })
    }
  };
}

console.log(JSON.stringify(output, null, 2));
