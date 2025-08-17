// agent/src/server.ts
import express from "express";
import cors from "cors";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ensureMcp } from "./mcpClient.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";

// ---------- tiny utils ----------
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function fmtDist(m?: number | null) {
  if (m == null || !Number.isFinite(m)) return "不明";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function haversineMeters(lon1:number, lat1:number, lon2:number, lat2:number) {
  const toRad = (d:number)=>d*Math.PI/180;
  const R = 6371_000;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// ---------- fallbacks (EN / JA) ----------
function fallbackExplain(sr: any): string {
  const shelters = sr?.shelters ?? {};
  const schools  = sr?.schools ?? {};
  const healths  = sr?.health ?? sr?.healths ?? {};

  const s01  = Math.max(0, Math.min(1, Number(sr?.score) || 0));
  const s100 = Math.round(s01 * 100);

  const lines: string[] = [];
  lines.push(`Overall score: ${s01.toFixed(2)} (≈ ${s100}/100).`);

  const missing: string[] = [];
  if ((shelters.count ?? 0) === 0) missing.push("shelters");
  if ((healths.count  ?? 0) === 0) missing.push("health facilities");
  if (missing.length) lines.push(`No ${missing.join(" and ")} found within the search radius.`);

  if ((schools.count ?? 0) > 0) {
    lines.push(`Schools: ${schools.count}; nearest ${fmtDist(schools.nearest?.distance_m)}.`);
  }
  if ((shelters.count ?? 0) === 0 && shelters.nearest) {
    lines.push(`Nearest shelter (outside radius): ${fmtDist(shelters.nearest.distance_m)}.`);
  }
  if ((healths.count ?? 0) === 0 && healths.nearest) {
    lines.push(`Nearest health facility (outside radius): ${fmtDist(healths.nearest.distance_m)}.`);
  }
  lines.push("Scale (0–1): 0–0.30 low, 0.30–0.70 moderate, 0.70–1.00 high.");
  return lines.join("\n");
}

function fallbackExplainJa(sr: any): string {
  const shelters = sr?.shelters ?? {};
  const schools  = sr?.schools ?? {};
  const healths  = sr?.health ?? sr?.healths ?? {};

  const s01  = Math.max(0, Math.min(1, Number(sr?.score) || 0));
  const s100 = Math.round(s01 * 100);

  const lines: string[] = [];
  lines.push(`総合スコア: ${s01.toFixed(2)}（約 ${s100}/100）。`);

  const none: string[] = [];
  if ((shelters.count ?? 0) === 0) none.push("避難所");
  if ((healths.count  ?? 0) === 0) none.push("医療・保健施設");
  if (none.length) lines.push(`検索半径内に${none.join("・")}は見つかりませんでした。`);

  if ((schools.count ?? 0) > 0) {
    lines.push(`学校は${schools.count}件、最寄りは ${fmtDist(schools.nearest?.distance_m)}。`);
  }
  if ((shelters.count ?? 0) === 0 && shelters.nearest) {
    lines.push(`（半径外）最寄りの避難所: ${fmtDist(shelters.nearest.distance_m)}。`);
  }
  if ((healths.count ?? 0) === 0 && healths.nearest) {
    lines.push(`（半径外）最寄りの医療・保健: ${fmtDist(healths.nearest.distance_m)}。`);
  }
  lines.push("指標（0–1）: 0–0.30 低い / 0.30–0.70 中程度 / 0.70–1.00 高い。");
  return lines.join("\n");
}

// ---------- OSM fallback (Overpass API) ----------
type OSMEl = {
  type: "node"|"way"|"relation";
  id: number;
  lat?: number; lon?: number;
  center?: { lat:number; lon:number };
  tags?: Record<string,string>;
};
type OverpassResponse = { elements?: OSMEl[] };

async function fetchOSM(lon:number, lat:number, radiusMeters:number) {
  const query = `
[out:json][timeout:25];
(
  nwr["amenity"="school"](around:${radiusMeters},${lat},${lon});
  nwr["amenity"="kindergarten"](around:${radiusMeters},${lat},${lon});
  nwr["amenity"="college"](around:${radiusMeters},${lat},${lon});
  nwr["amenity"="university"](around:${radiusMeters},${lat},${lon});

  nwr["amenity"="hospital"](around:${radiusMeters},${lat},${lon});
  nwr["amenity"="clinic"](around:${radiusMeters},${lat},${lon});
  nwr["amenity"="doctors"](around:${radiusMeters},${lat},${lon});

  nwr["amenity"="shelter"](around:${radiusMeters},${lat},${lon});
  nwr["emergency"="assembly_point"](around:${radiusMeters},${lat},${lon});
);
out center tags;`;

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: query
  });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const json = (await res.json()) as OverpassResponse;
  return json.elements ?? [];
}

function classifyOSM(els: OSMEl[], lon:number, lat:number) {
  const out = { schools: [] as any[], healths: [] as any[], shelters: [] as any[] };
  for (const e of els) {
    const c = e.center || (e.lat != null && e.lon != null ? { lat:e.lat, lon:e.lon } : null);
    if (!c) continue;
    const name = e.tags?.name ?? e.tags?.["name:ja"] ?? e.tags?.["name:en"] ?? "(unnamed)";
    const d = haversineMeters(lon, lat, c.lon, c.lat);
    const feat = { name, lon: c.lon, lat: c.lat, distance_m: d };

    const amenity = e.tags?.amenity;
    const emergency = e.tags?.emergency;

    if (["school","kindergarten","college","university"].includes(amenity || "")) out.schools.push(feat);
    else if (["hospital","clinic","doctors"].includes(amenity || "")) out.healths.push(feat);
    else if (amenity === "shelter" || emergency === "assembly_point") out.shelters.push(feat);
  }
  for (const k of ["schools","healths","shelters"] as const) out[k].sort((a,b)=>a.distance_m-b.distance_m);
  return out;
}

function enrichWithOSM(scoreResult:any, osm:any, weights?:{shelter:number;school:number;health:number}) {
  const used:string[] = [];
  const ensureBucket = (b:any) => b ?? { count:0, nearest:null };

  scoreResult.shelters = ensureBucket(scoreResult.shelters);
  scoreResult.schools  = ensureBucket(scoreResult.schools);
  scoreResult.healths  = scoreResult.healths ?? ensureBucket(scoreResult.health ?? null);

  if ((scoreResult.shelters.count ?? 0) === 0 && osm.shelters.length) {
    scoreResult.shelters.count = osm.shelters.length;
    scoreResult.shelters.nearest = { ...osm.shelters[0], kind:"shelter" };
    used.push("shelters");
  }
  if ((scoreResult.schools.count ?? 0) === 0 && osm.schools.length) {
    scoreResult.schools.count = osm.schools.length;
    scoreResult.schools.nearest = { ...osm.schools[0], kind:"school" };
    used.push("schools");
  }
  const hKey = scoreResult.healths ? "healths":"health";
  if ((scoreResult[hKey]?.count ?? 0) === 0 && osm.healths.length) {
    scoreResult[hKey] = ensureBucket(scoreResult[hKey]);
    scoreResult[hKey].count = osm.healths.length;
    scoreResult[hKey].nearest = { ...osm.healths[0], kind:"health" };
    used.push("health");
  }

  if (used.length && weights) {
    let s = 0;
    if ((scoreResult.shelters.count ?? 0) > 0) s += weights.shelter;
    if ((scoreResult.schools.count  ?? 0) > 0) s += weights.school;
    const hc = (scoreResult.healths?.count ?? scoreResult.health?.count ?? 0);
    if (hc > 0) s += weights.health;
    scoreResult.score = Math.max(Number(scoreResult.score ?? 0), Math.min(1, s));
    scoreResult.explain = String(scoreResult.explain || "").concat(` (+ OSM fallback used for: ${used.join(", ")})`);
    scoreResult._enrichment = { source: "OSM", used };
  }
  return scoreResult;
}

// ---------- routes ----------
app.get("/ai/explain", async (req, res) => {
  try {
    const lon = num(req.query.lon);
    const lat = num(req.query.lat);
    const radiusMeters = num(req.query.radius) ?? 1500;
    const noOSM = String(req.query.no_osm || "").toLowerCase() === "1";

    if (lon == null || lat == null) {
      return res.status(400).json({ error: "lon and lat are required numbers" });
    }

    // 1) Call the MCP tool (MLIT-derived)
    const { mcp } = await ensureMcp();
    const toolRes = await mcp.callTool({
      name: "score_point",
      arguments: { lon, lat, radiusMeters, includeDiagnostics: false },
    });

    // Normalize tool content -> JSON
    const content: any[] = (toolRes as any)?.content ?? [];
    const first = Array.isArray(content) ? content[0] : null;
    const scoreResult =
      first?.type === "json" ? (first as any).json : JSON.parse(first?.text ?? "{}");

    // 2) OSM enrichment when MLIT buckets are empty
    if (!noOSM) {
      const needsShelter = (scoreResult?.shelters?.count ?? 0) === 0;
      const needsSchool  = (scoreResult?.schools?.count  ?? 0) === 0;
      const healthB = scoreResult?.healths ?? scoreResult?.health;
      const needsHealth  = (healthB?.count ?? 0) === 0;

      if (needsShelter || needsSchool || needsHealth) {
        try {
          const els = await fetchOSM(lon!, lat!, radiusMeters);
          const osm = classifyOSM(els, lon!, lat!);
          const weights = scoreResult?.params?.weights ?? { shelter:0.5, school:0.3, health:0.2 };
          enrichWithOSM(scoreResult, osm, weights);
        } catch (e) {
          console.warn("[OSM fallback] skipped:", (e as any)?.message || e);
        }
      }
    }

    // 3) Prepare bilingual explanation
    const score01  = Math.max(0, Math.min(1, Number(scoreResult?.score) || 0));
    const score100 = Math.round(score01 * 100);

    let explanation = {
      en: fallbackExplain(scoreResult),
      ja: fallbackExplainJa(scoreResult),
    };

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (apiKey) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

        const prompt = `
Return ONLY valid JSON (no markdown, no extra text) with two fields: "en" and "ja".
"en" must be an English explanation. "ja" must be a natural Japanese explanation.
Use the normalized 0–1 score (you may include the 0–100 in parentheses).

{
  "en": "...",
  "ja": "..."
}

Normalized score (0–1): ${score01.toFixed(2)} (≈ ${score100}/100)

JSON data to base your explanation on:
${JSON.stringify(scoreResult, null, 2)}

Guidelines:
- Concise, factual, non-alarmist.
- Include bullet-style factors that raised/lowered the score (counts & nearest distances).
- If a category is 0 within the radius, mention the nearest (with distance in meters).
- Interpretation for 0–1: 0–0.30 low, 0.30–0.70 moderate, 0.70–1.00 high.
`;

        const resp = await model.generateContent(prompt);
        const raw = resp?.response?.text?.() || "";
        try {
          const j = JSON.parse(raw);
          explanation = {
            en: (j?.en ?? explanation.en).toString().trim(),
            ja: (j?.ja ?? explanation.ja).toString().trim(),
          };
        } catch {
          // keep fallbacks
        }
      } catch (e) {
        console.warn("[Gemini] Falling back:", (e as any)?.message || e);
      }
    }

    res.json({ scoreResult, explanation });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// health check
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Agent server listening on http://localhost:${PORT}`);
  console.log(`GET /ai/explain?lon=139.59954&lat=35.432684&radius=1500`);
});
