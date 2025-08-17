A small local prototype that scores a location based on nearby **shelters, schools, and health facilities**, and provides an explanation (English + Japanese).  
The **agent** (Express) serves a Leaflet map UI and calls a local **Safety MCP** server bundled in this repo. If a MLIT bucket is empty, the agent can enrich with OpenStreetMap (Overpass) as a fallback.

## Repo layout

evac-proto/
├─ agent/ # Express server + static front-end (Leaflet UI)
│ ├─ public/index.html # UI
│ └─ src/
│ ├─ server.ts # /ai/explain endpoint (calls MCP + Gemini)
│ └─ mcpClient.ts # spawns MCP via npm --prefix ../mcp-servers/safety
└─ mcp-servers/
└─ safety/ # Safety MCP server + data layers (GeoJSON)
├─ data/*.geojson
└─ src/


---

## Prerequisites

- **Node.js 18+** (20+ recommended)
- Any terminal (PowerShell, cmd, bash, zsh)

---

## Quickstart (the shortest path)

> The agent auto-starts the MCP server, but the **first time** you must install the MCP’s dependencies.

```bash
# 1) Install dependencies for the MCP (first time only)
cd mcp-servers/safety
npm install

# 2) Start the agent (serves the UI at http://localhost:5173)
cd ../../agent
npm install

# OPTIONAL: AI explanations (Gemini). If omitted, a local fallback is used.
# Windows PowerShell:
#   $env:GEMINI_API_KEY="YOUR_GOOGLE_GEMINI_API_KEY"
# macOS/Linux:
#   export GEMINI_API_KEY="YOUR_GOOGLE_GEMINI_API_KEY"

npm run dev

```

Open http://localhost:5173 and click on the map. Use the radius slider to widen/narrow the search area.

How it works

Scoring (0–1): weighted composite

shelters 0.5, schools 0.3, health 0.2

combines count (saturating curve) and proximity (nearer is better)

stricter normalization reduces “easy” 1.00 scores

Data sources: local GeoJSON (MLIT-derived), optionally enriched by OSM (Overpass) when a bucket is empty.

AI explanations: if GEMINI_API_KEY is set, Gemini returns bilingual explanations; otherwise, a concise built-in fallback (EN/JA) is used.


Useful commands

Agent

cd agent
npm run dev            # Start server at http://localhost:5173


Safety MCP (manual test)

cd mcp-servers/safety
npm run mcp            # You should see "MCP server ready..." logs
# Ctrl+C to stop. (The agent normally starts this automatically.)


API (dev)

GET /ai/explain?lon=<number>&lat=<number>&radius=<meters>
→ { scoreResult, explanation }

GET /healthz → { ok: true }

Troubleshooting

“MCP error -32000: Connection closed”
The agent couldn’t start the MCP process.

Ensure it’s installed once:

cd mcp-servers/safety
npm install


Start the agent again:

cd ../../agent
npm run dev


If needed, test MCP manually with npm run mcp (see above) to confirm it starts.

Port already in use
Choose another port:

Windows PowerShell:

$env:PORT=5174
npm run dev


macOS/Linux:

PORT=5174 npm run dev


Gemini quota / no key
Explanations fall back to a local EN/JA text—no action required.

Overpass throttling
OSM enrichment may be skipped temporarily; scoring still uses local data.

License

Add a license of your choice (MIT recommended).
