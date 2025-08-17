// scripts/mlit-build-layers.mjs
// Build local layers (shelters, schools, shops) from MLIT GraphQL search.
// Env: MLIT_API_KEY
import fs from "node:fs";
import path from "node:path";
import axios from "axios";

const ENDPOINT = "https://www.mlit-data.jp/api/v1/";
const API_KEY = process.env.MLIT_API_KEY;
if (!API_KEY) {
  console.error("[mlit] ERROR: MLIT_API_KEY not set");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
  })
);

const outdir = args.outdir || "./data";
const pref = args.pref || "";
const bboxStr = args.bbox || ""; // "minLon,minLat,maxLon,maxLat"
const SELFTEST = !!args.selftest;

function parseBbox(s) {
  if (!s) return null;
  const parts = s.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  return { minLon: parts[0], minLat: parts[1], maxLon: parts[2], maxLat: parts[3] };
}

const bbox = parseBbox(bboxStr);

const LAYERS = [
  {
    name: "shelters",
    terms: ["避難施設", "避難所", "指定避難所"],
  },
  {
    name: "schools",
    terms: ["学校", "小学校", "中学校", "高校"],
  },
  {
    name: "shops",
    terms: ["商店", "スーパーマーケット", "ショッピング"],
  },
];

// -------- GraphQL helpers --------
async function gql(query, variables) {
  const res = await axios.post(
    ENDPOINT,
    { query, variables },
    { headers: { "Content-Type": "application/json", apikey: API_KEY } }
  );
  if (res.data?.errors) throw new Error(JSON.stringify(res.data.errors, null, 2));
  return res.data?.data;
}

// ultra-minimal selection for DataClass
const SEL_MIN = `
  __typename
  id
  title
  lat
  lon
`;

// second fallback: just id/title (some rows may miss lat/lon)
const SEL_TINY = `
  __typename
  id
  title
`;

function makeQuery(selection) {
  // note: bbox & pref are optional
  // MLIT schema accepts: search(term: Any!, first: Int!, bbox: GeoBoundingBoxInput, prefecture: String)
  return `
    query($term: Any!, $first: Int!, $bbox: GeoBoundingBoxInput, $pref: String) {
      search(term: $term, first: $first, bbox: $bbox, prefecture: $pref) {
        totalNumber
        searchResults {
          ... on DataClass {
            ${selection}
          }
          __typename
        }
      }
    }
  `;
}

async function searchOnce(term, first, bbox, pref, selection) {
  const q = makeQuery(selection);
  const variables = { term, first };
  if (bbox) variables.bbox = bbox;
  if (pref && pref !== "(none)") variables.pref = pref;

  try {
    return await gql(q, variables);
  } catch (e) {
    // surface server message if present
    const msg = e?.response?.data || e?.message || e;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg, null, 2));
  }
}

function toFeature(r) {
  const lon = Number(r?.lon);
  const lat = Number(r?.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return {
    type: "Feature",
    properties: {
      id: r?.id ?? null,
      title: r?.title ?? "",
      source: "MLIT",
    },
    geometry: { type: "Point", coordinates: [lon, lat] },
  };
}

function saveGeoJSON(file, features) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fc = { type: "FeatureCollection", features };
  fs.writeFileSync(file, JSON.stringify(fc, null, 2), "utf8");
  console.log(`[mlit]  -> ${path.basename(file)}: kept ${features.length} features -> ${file}`);
}

async function buildLayer({ name, terms }) {
  console.log(`[mlit] building layer: ${name} — terms: ${terms.join(" OR ")}`);
  let all = [];

  for (const term of terms) {
    try {
      // try minimal selection first
      const d1 = await searchOnce(term, 500, bbox, pref, SEL_MIN);
      let rows = d1?.search?.searchResults || [];
      // if zero or error-like, try fallback selection
      if (!rows.length) {
        const d2 = await searchOnce(term, 500, bbox, pref, SEL_TINY);
        rows = d2?.search?.searchResults || [];
      }
      console.log(`[mlit]  term="${term}" total=${d1?.search?.totalNumber ?? "?"} pulled=${rows.length}`);
      all.push(...rows);
    } catch (err) {
      console.log(`[mlit]  term="${term}" failed: ${typeof err === "string" ? err : JSON.stringify(err, null, 2)}`);
    }
  }

  // map to GeoJSON
  const feats = [];
  for (const r of all) {
    if (r?.__typename !== "DataClass") continue;
    const f = toFeature(r);
    if (f) feats.push(f);
  }

  // de-dup by id+coords
  const seen = new Set();
  const unique = feats.filter((f) => {
    const k = `${f.properties.id}|${f.geometry.coordinates.join(",")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const outfile = path.join(outdir, `${name}.geojson`);
  saveGeoJSON(outfile, unique);
}

(async () => {
  try {
    console.log(`[mlit] building MLIT-backed layers (pref="${pref || "(none)"}")`);
    if (bbox) {
      console.log(`[mlit] using bbox: ${bbox.minLon}, ${bbox.minLat}, ${bbox.maxLon}, ${bbox.maxLat}`);
    }
    // quick auth probe with a super-tiny query
    await gql(`query{ __typename }`, {});
    console.log(`[mlit] auth OK using mode="apikey"`);

    if (SELFTEST) {
      console.log(`[mlit] SELFTEST passed with mode="apikey" on ${ENDPOINT}`);
      process.exit(0);
    }

    for (const layer of LAYERS) {
      await buildLayer(layer);
    }
    console.log("[mlit] done.");
  } catch (e) {
    const msg = e?.response?.data ?? e?.message ?? e;
    console.error("[mlit] ERROR:", typeof msg === "string" ? msg : JSON.stringify(msg, null, 2));
    process.exit(2);
  }
})();
