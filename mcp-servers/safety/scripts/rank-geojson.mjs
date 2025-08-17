// scripts/rank-geojson.mjs
// Rank a place (lon/lat) using three GeoJSON layers: shelters, schools, shops.
//
// Usage:
//   node scripts/rank-geojson.mjs --lon=139.767 --lat=35.681 --radius=800 \
//     --shelters=./data/shelters.geojson --schools=./data/schools.geojson --shops=./data/shops.geojson
//
// Notes:
// - Score is 0..100, higher = better.
// - Components:
//   A) Nearness to the closest shelter (closer is better)
//   B) # of schools within radius
//   C) # of shops within radius

import fs from "node:fs";
import path from "node:path";

// -------- tiny arg parser --------
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
  })
);

function reqNum(name, def) {
  const v = args[name] != null ? Number(args[name]) : def;
  if (Number.isNaN(v)) throw new Error(`Invalid numeric --${name}`);
  return v;
}

function reqStr(name, def) {
  const v = args[name] != null ? String(args[name]) : def;
  if (!v) throw new Error(`Missing --${name}`);
  return v;
}

// -------- inputs --------
const lon = reqNum("lon");
const lat = reqNum("lat");
const radiusM = reqNum("radius", 800); // default search radius 800 m

const sheltersPath = reqStr("shelters", "./data/shelters.geojson");
const schoolsPath  = reqStr("schools",  "./data/schools.geojson");
const shopsPath    = reqStr("shops",    "./data/shops.geojson");

// -------- utils --------
function readGeoJSON(p) {
  const raw = fs.readFileSync(path.resolve(p), "utf8");
  const json = JSON.parse(raw);
  const feats = Array.isArray(json.features) ? json.features : [];
  return feats
    .map((f) => {
      const g = f?.geometry;
      const coords = g?.coordinates;
      if (!g || g.type !== "Point" || !Array.isArray(coords) || coords.length < 2) return null;
      const title = (f.properties?.title ?? f.properties?.name ?? "").toString();
      return { title, lon: Number(coords[0]), lat: Number(coords[1]), props: f.properties || {} };
    })
    .filter(Boolean);
}

function haversineM(lon1, lat1, lon2, lat2) {
  const R = 6371e3;
  const toRad = (x) => (x * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestDistanceM(pois, lon, lat) {
  let best = Infinity;
  let bestPoi = null;
  for (const p of pois) {
    const d = haversineM(lon, lat, p.lon, p.lat);
    if (d < best) {
      best = d;
      bestPoi = p;
    }
  }
  return { distanceM: Number.isFinite(best) ? Math.round(best) : null, poi: bestPoi };
}

function countWithin(pois, lon, lat, radius) {
  const list = [];
  for (const p of pois) {
    const d = haversineM(lon, lat, p.lon, p.lat);
    if (d <= radius) list.push({ ...p, distanceM: Math.round(d) });
  }
  // sort by distance
  list.sort((a, b) => a.distanceM - b.distanceM);
  return list;
}

// -------- load data --------
const shelters = readGeoJSON(sheltersPath);
const schools  = readGeoJSON(schoolsPath);
const shops    = readGeoJSON(shopsPath);

// -------- metrics --------
// A) closeness to shelter → scoreShelter: 0..1 (closer → higher).
//    We use exponential decay with 300m scale: ~1 at 0m, ~0.72 at 100m, ~0.37 at 300m, ~0.14 at 600m.
const nearShelter = nearestDistanceM(shelters, lon, lat);
const shelterM = nearShelter.distanceM ?? null;
const scoreShelter = shelterM == null ? 0 : Math.exp(- (shelterM / 300));

// B) schools within radius → scoreSchools: 0..1. Cap at 5 (>=5 schools gets full 1.0)
const schoolsNear = countWithin(schools, lon, lat, radiusM);
const scoreSchools = Math.min(schoolsNear.length / 5, 1);

// C) shops within radius → scoreShops: 0..1. Cap at 10 (>=10 shops gets full 1.0)
const shopsNear = countWithin(shops, lon, lat, radiusM);
const scoreShops = Math.min(shopsNear.length / 10, 1);

// weights (tweak freely)
const W_SHELTER = 0.5;
const W_SCHOOLS = 0.25;
const W_SHOPS   = 0.25;

// final score 0..100
const score0to1 = W_SHELTER * scoreShelter + W_SCHOOLS * scoreSchools + W_SHOPS * scoreShops;
const score100  = Math.round(score0to1 * 100);

// prepare a short explanation
const explain = [
  `Shelter: ${shelterM == null ? "no data" : `${shelterM} m to nearest`}`,
  `Schools in ${radiusM}m: ${schoolsNear.length}`,
  `Shops in ${radiusM}m: ${shopsNear.length}`,
  `Weights — shelter:${W_SHELTER}, schools:${W_SCHOOLS}, shops:${W_SHOPS}`,
];

// limit detail lists to keep output short
function brief(list, n = 5) {
  return list.slice(0, n).map(({ title, lon, lat, distanceM }) => ({
    title, lon, lat, distanceM
  }));
}

// -------- output --------
const output = {
  input: { lon, lat, radiusM, files: { shelters: sheltersPath, schools: schoolsPath, shops: shopsPath } },
  dataStats: { shelters: shelters.length, schools: schools.length, shops: shops.length },
  components: {
    shelter: { nearestM: shelterM, score: Number(scoreShelter.toFixed(3)), nearestTitle: nearShelter.poi?.title || null },
    schools: { countWithin: schoolsNear.length, score: Number(scoreSchools.toFixed(3)) },
    shops:   { countWithin: shopsNear.length,   score: Number(scoreShops.toFixed(3)) },
  },
  score: score100,
  explain,
  nearby: {
    shelters: nearShelter.poi ? [{ title: nearShelter.poi.title, lon: nearShelter.poi.lon, lat: nearShelter.poi.lat, distanceM: shelterM }] : [],
    schools: brief(schoolsNear),
    shops:   brief(shopsNear),
  }
};

console.log(JSON.stringify(output, null, 2));
