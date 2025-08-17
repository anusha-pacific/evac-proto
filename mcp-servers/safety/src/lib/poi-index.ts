// src/lib/poi-index.ts
import fs from "fs";
import path from "path";

/** ---------- Types ---------- */

export type Poi = {
  name: string;
  lon: number;
  lat: number;
  primary?: string | null;
  tags?: string[] | null;
};

export type PoiNear = Poi & { distance_m: number; kind: "shelter" | "school" | "health" };

export type NearbyResult = {
  shelters: PoiNear[];
  schools: PoiNear[];
  healths: PoiNear[];
  /** Combined list (all categories), sorted by distance */
  all: PoiNear[];
  params: { lon: number; lat: number; radiusMeters: number; topN: number };
};

export type ScoreParams = {
  lon: number;
  lat: number;
  radiusMeters?: number;
  topN?: number;
  includeDiagnostics?: boolean;
};

export type ScoreResult = {
  shelters: { count: number; nearest: PoiNear | null };
  schools: { count: number; nearest: PoiNear | null };
  healths: { count: number; nearest: PoiNear | null };
  /** 0..1 normalized score */
  score: number;
  /** Short human explanation */
  explain: string;
  params: { lon: number; lat: number; radiusMeters: number; weights: Weights; topN: number };
  _diagnostics?: Diagnostics;
};

type Diagnostics = {
  shelter: { file: string; features: number; samples: Poi[] };
  school: { file: string; features: number; samples: Poi[] };
  health: { files: string[]; features: number; samples: Poi[] };
};

type Weights = { shelter: number; school: number; health: number };

/** ---------- Config ---------- */

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");

// Files we expect
const FILES = {
  shelter: path.join(DATA_DIR, "shelters.geojson"),
  school: path.join(DATA_DIR, "schools.geojson"),
  health: path.join(DATA_DIR, "health.geojson"),
  hospital: path.join(DATA_DIR, "hospitals.geojson"),
};

// STRICTER scoring weights / knobs
// - Shelters weigh more
// - Counts saturate slower (K=4)
// - Proximity influence reduced and decays faster near the edge
const WEIGHTS: Weights = { shelter: 0.6, school: 0.25, health: 0.15 };
const COUNT_SAT_K = 4;   // saturation constant for n/(n+K) — larger => stricter
const MIX_COUNTS = 0.8;  // how much counts matter inside a category
const MIX_PROX = 1 - MIX_COUNTS;

/** ---------- Geo helpers ---------- */

const R_EARTH = 6371000; // meters
function toRad(d: number) { return (d * Math.PI) / 180; }
function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2 - lat1);
  const dλ = toRad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

/** ---------- Lazy data loading & parsing ---------- */

type Layers = { shelter: Poi[]; school: Poi[]; health: Poi[] };
let LAYERS: Layers | null = null;

function readGeoPoints(file: string): Poi[] {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const feats = Array.isArray(raw?.features) ? raw.features : [];
  const out: Poi[] = [];
  for (const f of feats) {
    const g = f?.geometry;
    if (!g || g.type !== "Point") continue;
    const [lon, lat] = g.coordinates ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const name = (f?.properties?.name ?? "").toString().trim();
    if (!name) continue;
    out.push({
      name,
      lon: Number(lon),
      lat: Number(lat),
      primary: f?.properties?.primary ?? null,
      tags: f?.properties?.tags ?? null,
    });
  }
  return dedupePois(out);
}

function dedupePois(list: Poi[]): Poi[] {
  const seen = new Set<string>();
  const out: Poi[] = [];
  for (const p of list) {
    const key = `${p.name}|${p.lon}|${p.lat}`;
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

function ensureLoaded(): Layers {
  if (LAYERS) return LAYERS;

  const shelter = readGeoPoints(FILES.shelter);
  const school = readGeoPoints(FILES.school);
  const healthA = readGeoPoints(FILES.health);
  const healthB = readGeoPoints(FILES.hospital); // alias/merge
  const health = dedupePois([...healthA, ...healthB]);

  LAYERS = { shelter, school, health };
  return LAYERS;
}

/** ---------- Core queries ---------- */

function withDistances(kind: PoiNear["kind"], arr: Poi[], lon: number, lat: number): PoiNear[] {
  return arr.map((p) => ({
    ...p,
    distance_m: haversineMeters(lon, lat, p.lon, p.lat),
    kind,
  }));
}

function withinRadius(sortedByDistance: PoiNear[], radiusMeters: number): PoiNear[] {
  return sortedByDistance.filter((p) => p.distance_m <= radiusMeters);
}

/** Public: list nearby POIs by category */
export function nearbyPois(
  lon: number,
  lat: number,
  radiusMeters: number = 1500,
  topN: number = 25
): NearbyResult {
  const L = ensureLoaded();
  const s = withDistances("shelter", L.shelter, lon, lat).sort((a, b) => a.distance_m - b.distance_m);
  const c = withDistances("school", L.school, lon, lat).sort((a, b) => a.distance_m - b.distance_m);
  const h = withDistances("health", L.health, lon, lat).sort((a, b) => a.distance_m - b.distance_m);

  const shelters = withinRadius(s, radiusMeters).slice(0, topN);
  const schools  = withinRadius(c, radiusMeters).slice(0, topN);
  const healths  = withinRadius(h, radiusMeters).slice(0, topN);
  const all = [...shelters, ...schools, ...healths].sort((a, b) => a.distance_m - b.distance_m);

  return {
    shelters, schools, healths, all,
    params: { lon, lat, radiusMeters, topN }
  };
}

/** Public: score a point (strict) */
export function scorePoint(params: ScoreParams): ScoreResult {
  const lon = Number(params.lon);
  const lat = Number(params.lat);
  const radiusMeters = Number(params.radiusMeters ?? 1500);
  const topN = Number(params.topN ?? 25);

  const nearby = nearbyPois(lon, lat, radiusMeters, topN);

  const cat = {
    shelters: {
      count: nearby.shelters.length,
      nearest: nearby.shelters[0] ?? null,
    },
    schools: {
      count: nearby.schools.length,
      nearest: nearby.schools[0] ?? null,
    },
    healths: {
      count: nearby.healths.length,
      nearest: nearby.healths[0] ?? null,
    },
  };

  // Category scores = weight * ( MIX_COUNTS * countNorm + MIX_PROX * proximityBoost )
  // countNorm = n / (n + K) with larger K => stricter (needs more places)
  // proximityBoost = max(0, 1 - d/r)^1.3 to reduce credit for far edges
  const sCount = cat.shelters.count, sNearest = cat.shelters.nearest?.distance_m ?? Infinity;
  const cCount = cat.schools.count,  cNearest = cat.schools.nearest?.distance_m ?? Infinity;
  const hCount = cat.healths.count,  hNearest = cat.healths.nearest?.distance_m ?? Infinity;

  const sCountNorm = sCount / (sCount + COUNT_SAT_K);
  const cCountNorm = cCount / (cCount + COUNT_SAT_K);
  const hCountNorm = hCount / (hCount + COUNT_SAT_K);

  const prox = (d: number) => {
    if (!Number.isFinite(d)) return 0;
    const raw = clamp01(1 - d / radiusMeters);
    return Math.pow(raw, 1.3); // harsher near the edge
  };

  const sProx = prox(sNearest);
  const cProx = prox(cNearest);
  const hProx = prox(hNearest);

  const sScore = WEIGHTS.shelter * (MIX_COUNTS * sCountNorm + MIX_PROX * sProx);
  const cScore = WEIGHTS.school  * (MIX_COUNTS * cCountNorm + MIX_PROX * cProx);
  const hScore = WEIGHTS.health  * (MIX_COUNTS * hCountNorm + MIX_PROX * hProx);

  const score = clamp01(sScore + cScore + hScore);

  const explain = [
    `半径${radiusMeters}m 内:`,
    `避難所 ${sCount}件`,
    `学校 ${cCount}件`,
    `医療/保健 ${hCount}件`,
    `→ 総合スコア ${score.toFixed(2)}`
  ].join(" / ");

  const result: ScoreResult = {
    ...cat,
    score,
    explain,
    params: { lon, lat, radiusMeters, weights: WEIGHTS, topN }
  };

  if (params.includeDiagnostics) {
    const L = ensureLoaded();
    result._diagnostics = {
      shelter: {
        file: FILES.shelter,
        features: L.shelter.length,
        samples: L.shelter.slice(0, 3),
      },
      school: {
        file: FILES.school,
        features: L.school.length,
        samples: L.school.slice(0, 3),
      },
      health: {
        files: [FILES.health, FILES.hospital],
        features: L.health.length,
        samples: L.health.slice(0, 3),
      },
    };
  }

  return result;
}

/** Optional: expose counts for quick sanity checks (not used by UI/MCP) */
export function layerCounts(): { shelter: number; school: number; health: number } {
  const L = ensureLoaded();
  return { shelter: L.shelter.length, school: L.school.length, health: L.health.length };
}
