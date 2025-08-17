// scripts/rank-offline.mjs
import fs from "node:fs";
import path from "node:path";

function haversineKm(a, b) {
  const R = 6371, toRad = x => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]), lat2 = toRad(b[1]);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const metersBetween = (a,b)=>haversineKm(a,b)*1000;

const args = Object.fromEntries(process.argv.slice(2).map(s=>{
  const m=s.match(/^--([^=]+)=(.*)$/); return m?[m[1],m[2]]:[s,true];
}));
const lon = Number(args.lon ?? 139.767);   // near Tokyo Station
const lat = Number(args.lat ?? 35.681);
const radiusMeters = Number(args.radius ?? 1000);
const topN = Number(args.topN ?? 3);
const file = path.resolve(process.cwd(), "data/hazards-tokyo.geojson");

const fc = JSON.parse(fs.readFileSync(file, "utf8"));
const feats = Array.isArray(fc.features) ? fc.features : [];

const facilities = feats
  .filter(f => f?.geometry?.type === "Point")
  .map(f => {
    const [x,y] = f.geometry.coordinates;
    const p = f.properties || {};
    return {
      lon: Number(x),
      lat: Number(y),
      title: p.title || p.name || p.datasetName || p.名称 || "(unknown)",
      publisher: p.publisher || p.自治体名,
      url: p.url || p.link
    };
  });

const withDist = facilities.map(f => ({...f, distanceM: metersBetween([f.lon,f.lat],[lon,lat])}));
withDist.sort((a,b)=>a.distanceM-b.distanceM);
const within = withDist.filter(f=>f.distanceM<=radiusMeters);

const nearestM = withDist.length? Math.round(withDist[0].distanceM) : null;
const countWithin = within.length;
const nearestScore = nearestM==null?0:(1/(1+(nearestM/1000)));
const densityScore = Math.min(countWithin/10,1);
const score = Number((0.5*nearestScore + 0.5*densityScore).toFixed(4));

console.log(JSON.stringify({
  input:{lon,lat,radiusMeters,topN},
  totalFacilities: facilities.length,
  nearestDistanceM: nearestM,
  countWithinRadius: countWithin,
  score,
  topFacilities: withDist.slice(0, topN).map(f=>({
    title:f.title, publisher:f.publisher, url:f.url,
    lon:f.lon, lat:f.lat, distanceM: Math.round(f.distanceM)
  }))
}, null, 2));
