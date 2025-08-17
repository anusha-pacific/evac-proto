// src/server.ts
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
// ⬇️ FIX THIS LINE
import { scorePoint, nearbyPois } from "./lib/poi-index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, "..");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// static site (your map UI)
app.use(express.static(path.join(ROOT, "public")));

// /score?lon=..&lat=..&radius=..
app.get("/score", (req, res) => {
  const lon = Number(req.query.lon);
  const lat = Number(req.query.lat);
  const radius = Number(req.query.radius ?? 1500);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    res.status(400).json({ error: "lon and lat are required numbers" });
    return;
  }
  try {
    const result = scorePoint({ lon, lat, radiusMeters: Number.isFinite(radius) ? radius : 1500 });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "scoring failed" });
  }
});

// optional: list nearby POIs
app.get("/nearby", (req, res) => {
  const lon = Number(req.query.lon);
  const lat = Number(req.query.lat);
  const radius = Number(req.query.radius ?? 1500);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    res.status(400).json({ error: "lon and lat are required numbers" });
    return;
  }
  try {
    res.json(nearbyPois(lon, lat, Number.isFinite(radius) ? radius : 1500));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "nearby failed" });
  }
});

app.listen(PORT, () => console.log(`safety web server at http://localhost:${PORT}`));
