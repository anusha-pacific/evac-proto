// mcp-servers/safety/src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scorePoint, nearbyPois } from "./lib/poi-index.js"; // <-- keep .js

const server = new McpServer({ name: "safety-mcp", version: "1.0.0" });

// ---- score_point ----
const ScoreShape = {
  lon: z.number().describe("Longitude (EPSG:4326)"),
  lat: z.number().describe("Latitude (EPSG:4326)"),
  radiusMeters: z.number().optional().describe("Search radius in meters (default 1500)"),
  includeDiagnostics: z.boolean().optional().describe("Include internal debug info"),
} as const;

server.tool(
  "score_point",
  "Score safety/amenity for a coordinate (lon, lat) within a radius (m).",
  ScoreShape, // <-- raw shape, not z.object(...)
  async (args) => {
    const { lon, lat, radiusMeters, includeDiagnostics } = z.object(ScoreShape).parse(args);
    const result = scorePoint({
      lon,
      lat,
      radiusMeters: radiusMeters ?? 1500,
      includeDiagnostics: !!includeDiagnostics,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] }; // <-- text content
  }
);

// ---- nearby_pois ----
const NearbyShape = {
  lon: z.number(),
  lat: z.number(),
  radiusMeters: z.number().optional(),
} as const;

server.tool(
  "nearby_pois",
  "List shelters, schools, and health POIs near a point, sorted by distance.",
  NearbyShape,
  async (args) => {
    const { lon, lat, radiusMeters } = z.object(NearbyShape).parse(args);
    const items = nearbyPois(lon, lat, radiusMeters ?? 1500);
    return { content: [{ type: "text", text: JSON.stringify(items) }] }; // <-- text content
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
