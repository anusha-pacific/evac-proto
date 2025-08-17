// src/lib/score.ts
import fs from "fs";
import path from "path";

export type POI = { name: string; lon: number; lat: number; primary?: string; tags?: string[] };
export type LayerName = "shelter" | "school" | "health";

const DATA_DIR = path.join(process.cwd(), "data");
const FILES: Record<LayerName, string> = {
  shelter: path.join(DATA_DIR, "shelters.geojson"),
  school:  path.join(DATA_DIR, "schools.geojson"),
  health:  path.join(DATA_DIR, "health.geojson"),
};

type Feature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { name?: string; primary?: string; tags?: string[] };
};
type FC = { type: "FeatureCollection"; features: Feature[] };

const cache: Partial<Record<LayerName, POI[]>> = {};

function readPoints(layer: LayerName): POI[] {
  if (cache[layer]) return cache[layer]!;
  const p = FILES[layer];
  if (!fs.existsSync(p)) { cache[layer] = []; return []; }
  const fc = JSON.parse(fs.readFileSync(p, "utf8")) as FC;
  const pts: POI[] = [];
  for (const f of fc.features ?? []) {
    if (f?.geometry?.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    pts.push({
      name: (f.properties?.name ?? "").toString(),
      lon, lat,
      primary: f.properties?.primary,
      tags: f.properties?.tags,
    });
  }
  cache[layer] = pts;
  return pts;
}

const R = 6371000; // meters
function haversineMeters(lon1:number, lat1:number, lon2:number, lat2:number): number {
  const toRad = (d:number)=>d*Math.PI/180;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function nearest(points: POI[], lon:number, lat:number) {
  if (points.length===0) return null;
  let best = points[0], bestD = haversineMeters(lon,lat,best.lon,best.lat);
  for (let i=1;i<points.length;i++){
    const p = points[i];
    const d = haversineMeters(lon,lat,p.lon,p.lat);
    if (d < bestD){ best=p; bestD=d; }
  }
  return { poi: best, distance_m: Math.round(bestD) };
}

function within(points: POI[], lon:number, lat:number, radius:number): POI[] {
  const out: POI[] = [];
  for (const p of points){
    const d = haversineMeters(lon,lat,p.lon,p.lat);
    if (d <= radius) out.push(p);
  }
  return out;
}

export type ScoreParams = { lon:number; lat:number; radiusMeters?:number };
export type ScoreResult = {
  params: { lon:number; lat:number; radiusMeters:number };
  weights: { shelters:number; schools:number; healths:number };
  softCaps: { shelters:number; schools:number; healths:number };
  layers: {
    shelters: { count:number; nearest_m:number|null; nearest?:{name:string; lon:number; lat:number} };
    schools:  { count:number; nearest_m:number|null; nearest?:{name:string; lon:number; lat:number} };
    healths:  { count:number; nearest_m:number|null; nearest?:{name:string; lon:number; lat:number} };
  };
  score: number;            // 0..1
  explanation: string;      // short human text
};

export function scorePoint({ lon, lat, radiusMeters=1500 }: ScoreParams): ScoreResult {
  const shelters = readPoints("shelter");
  const schools  = readPoints("school");
  const healths  = readPoints("health");

  const w = { shelters: 0.5, schools: 0.3, healths: 0.2 };
  const cap = { shelters: 1, schools: 3, healths: 2 }; // counts that saturate each signal

  const nearShelters = within(shelters, lon, lat, radiusMeters);
  const nearSchools  = within(schools,  lon, lat, radiusMeters);
  const nearHealths  = within(healths,  lon, lat, radiusMeters);

  const ns = nearest(shelters, lon, lat);
  const nc = nearest(schools,  lon, lat);
  const nh = nearest(healths,  lon, lat);

  const avail = (count:number, nearest_m:number|null, softCap:number) => {
    if (count > 0) return Math.min(1, count/softCap);
    if (nearest_m == null) return 0;
    // availability fades with distance; 2km ~ 0.5, 10km ~ 0.17, 60km ~ ~0.03
    return 1 / (1 + nearest_m / 2000);
  };

  const aShelter = avail(nearShelters.length, ns?.distance_m ?? null, cap.shelters);
  const aSchool  = avail(nearSchools.length,  nc?.distance_m ?? null, cap.schools);
  const aHealth  = avail(nearHealths.length,  nh?.distance_m ?? null, cap.healths);

  const score = Number((
    w.shelters * aShelter +
    w.schools  * aSchool  +
    w.healths  * aHealth
  ).toFixed(4));

  const fmtDist = (m:number|null)=> m==null ? "—" :
    m >= 1000 ? `${(m/1000).toFixed(1)} km` : `${m} m`;

  const explanation =
    `半径${Math.round(radiusMeters)}m 以内: 避難所 ${nearShelters.length}、学校 ${nearSchools.length}、医療 ${nearHealths.length}。` +
    ` 最寄りの避難所 ${fmtDist(ns?.distance_m ?? null)}、学校 ${fmtDist(nc?.distance_m ?? null)}、医療 ${fmtDist(nh?.distance_m ?? null)}。` +
    ` 重み(避0.5/学0.3/医0.2)と距離で正規化しスコアは ${score}。`;

  return {
    params: { lon, lat, radiusMeters },
    weights: w,
    softCaps: cap,
    layers: {
      shelters: {
        count: nearShelters.length,
        nearest_m: ns?.distance_m ?? null,
        nearest: ns ? { name: ns.poi.name, lon: ns.poi.lon, lat: ns.poi.lat } : undefined
      },
      schools: {
        count: nearSchools.length,
        nearest_m: nc?.distance_m ?? null,
        nearest: nc ? { name: nc.poi.name, lon: nc.poi.lon, lat: nc.poi.lat } : undefined
      },
      healths: {
        count: nearHealths.length,
        nearest_m: nh?.distance_m ?? null,
        nearest: nh ? { name: nh.poi.name, lon: nh.poi.lon, lat: nh.poi.lat } : undefined
      },
    },
    score,
    explanation,
  };
}

export function nearbyPois(lon:number, lat:number, radiusMeters=1500) {
  const collect = (layer:LayerName)=> within(readPoints(layer), lon, lat, radiusMeters)
    .map(p => ({ layer, name: p.name, lon: p.lon, lat: p.lat,
      distance_m: Math.round(haversineMeters(lon,lat,p.lon,p.lat)) }))
    .sort((a,b)=>a.distance_m-b.distance_m);

  return {
    params: { lon, lat, radiusMeters },
    items: [
      ...collect("shelter"),
      ...collect("school"),
      ...collect("health"),
    ]
  };
}
