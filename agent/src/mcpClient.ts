// ranking_backend/src/mcpClient.ts
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let singletonPromise: Promise<{ mcp: Client }> | null = null;

export async function ensureMcp(): Promise<{ mcp: Client }> {
  if (singletonPromise) return singletonPromise;

  singletonPromise = (async () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // 1) Where is the MCP repo?
    const candidate =
      (process.env.SAFETY_MCP_DIR ?? "").trim() ||
      path.resolve(__dirname, "..", "..", "mcp-servers", "safety");
    const safetyDir = path.resolve(candidate);

    // Must have a package.json
    const pkg = path.join(safetyDir, "package.json");
    if (!fs.existsSync(pkg)) {
      throw new Error(
        `[MCP] package.json not found at: ${safetyDir}
Set SAFETY_MCP_DIR to the MCP repo folder (the one that contains src/mcp.ts and package.json).`
      );
    }

    // 2) Build command to run: use the local tsx binary directly
    const tsxBin = path.join(
      safetyDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx"
    );
    const useNpx = !fs.existsSync(tsxBin);

    const command = useNpx
      ? (process.platform === "win32" ? "npx.cmd" : "npx")
      : tsxBin;

    const args = useNpx ? ["tsx", "src/mcp.ts"] : ["src/mcp.ts"];

    // 3) Clean env
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }

    console.log(
      `[MCP] Spawning: ${command} ${args.join(" ")} (cwd=${safetyDir})`
    );

    // 4) IMPORTANT: run with cwd = MCP repo root
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      cwd: safetyDir,
    });

    const mcp = new Client({ name: "agent-client", version: "1.0.0" });
    await mcp.connect(transport);
    console.log("[MCP] Connected");
    return { mcp };
  })();

  return singletonPromise;
}
