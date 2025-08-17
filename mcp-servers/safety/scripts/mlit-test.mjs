// scripts/mlit-test.mjs
import axios from "axios";
import fs from "node:fs";

const ENDPOINT = "https://www.mlit-data.jp/api/v1/";
const API_KEY = process.env.MLIT_API_KEY;
if (!API_KEY) {
  console.error("Missing MLIT_API_KEY env var.");
  process.exit(1);
}

// tiny arg parser
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
  })
);

const mode = (args.mode || "search").toString();
const term = args.term ?? "";
const first = Number(args.first || 50);
const maxPages = Number(args.maxPages || 10);
const out = args.out || "";

async function gql(query, variables) {
  const res = await axios.post(
    ENDPOINT,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "apikey": API_KEY,
      },
      validateStatus: () => true, // let us see 400 bodies
    }
  );
  if (res.status !== 200 || res.data?.errors) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
    throw new Error(`HTTP ${res.status} ${body?.slice(0, 4000)}`);
  }
  return res.data.data;
}

function toDataset(node = {}) {
  return {
    id: node.id ?? node.datasetId ?? node.identifier ?? "(no id)",
    name: node.name ?? node.datasetName ?? node.title ?? "(no name)",
    description: node.description ?? node.summary ?? node.abstract ?? "",
  };
}

const SEARCH_CANDIDATES = [
  {
    name: "search.datasets.nodes (outer+inner args)",
    query: `
      query($term: Any!, $first: Int!, $after: String) {
        search(term: $term, first: $first, after: $after) {
          datasets(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id name title datasetId datasetName description summary }
          }
        }
      }`,
    extract: d => {
      const c = d?.search?.datasets;
      if (!c) return null;
      return { items: (c.nodes || []).map(toDataset), pageInfo: c.pageInfo };
    },
    vars: (after) => ({ term, first, after }),
  },
  {
    name: "search.datasets.edges (outer+inner args)",
    query: `
      query($term: Any!, $first: Int!, $after: String) {
        search(term: $term, first: $first, after: $after) {
          datasets(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id name title datasetId datasetName description summary } }
          }
        }
      }`,
    extract: d => {
      const c = d?.search?.datasets;
      if (!c) return null;
      return { items: (c.edges || []).map(e => toDataset(e.node)), pageInfo: c.pageInfo };
    },
    vars: (after) => ({ term, first, after }),
  },
  {
    name: "search.datasets.nodes (inner no args)",
    query: `
      query($term: Any!, $first: Int!) {
        search(term: $term, first: $first) {
          datasets {
            pageInfo { hasNextPage endCursor }
            nodes { id name title datasetId datasetName description summary }
          }
        }
      }`,
    extract: d => {
      const c = d?.search?.datasets;
      if (!c) return null;
      return { items: (c.nodes || []).map(toDataset), pageInfo: c.pageInfo };
    },
    vars: () => ({ term, first }),
  },
  {
    name: "search.datasets.edges (inner no args)",
    query: `
      query($term: Any!, $first: Int!) {
        search(term: $term, first: $first) {
          datasets {
            pageInfo { hasNextPage endCursor }
            edges { node { id name title datasetId datasetName description summary } }
          }
        }
      }`,
    extract: d => {
      const c = d?.search?.datasets;
      if (!c) return null;
      return { items: (c.edges || []).map(e => toDataset(e.node)), pageInfo: c.pageInfo };
    },
    vars: () => ({ term, first }),
  },
];

const CATALOG_CANDIDATES = [
  {
    name: "dataCatalog.datasets.nodes (inner args)",
    query: `
      query($first: Int!, $after: String) {
        dataCatalog {
          datasets(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id name title datasetId datasetName description summary }
          }
        }
      }`,
    extract: d => {
      const c = d?.dataCatalog?.datasets;
      if (!c) return null;
      return { items: (c.nodes || []).map(toDataset), pageInfo: c.pageInfo };
    },
    vars: (after) => ({ first, after }),
  },
  {
    name: "dataCatalog.datasets.edges (inner args)",
    query: `
      query($first: Int!, $after: String) {
        dataCatalog {
          datasets(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id name title datasetId datasetName description summary } }
          }
        }
      }`,
    extract: d => {
      const c = d?.dataCatalog?.datasets;
      if (!c) return null;
      return { items: (c.edges || []).map(e => toDataset(e.node)), pageInfo: c.pageInfo };
    },
    vars: (after) => ({ first, after }),
  },
  {
    name: "dataCatalog.datasets.nodes (inner no args)",
    query: `
      query {
        dataCatalog {
          datasets {
            pageInfo { hasNextPage endCursor }
            nodes { id name title datasetId datasetName description summary }
          }
        }
      }`,
    extract: d => {
      const c = d?.dataCatalog?.datasets;
      if (!c) return null;
      return { items: (c.nodes || []).map(toDataset), pageInfo: c.pageInfo };
    },
    vars: () => ({}),
  },
  {
    name: "dataCatalog.datasets.edges (inner no args)",
    query: `
      query {
        dataCatalog {
          datasets {
            pageInfo { hasNextPage endCursor }
            edges { node { id name title datasetId datasetName description summary } }
          }
        }
      }`,
    extract: d => {
      const c = d?.dataCatalog?.datasets;
      if (!c) return null;
      return { items: (c.edges || []).map(e => toDataset(e.node)), pageInfo: c.pageInfo };
    },
    vars: () => ({}),
  },
];

async function pageAll() {
  const acc = [];
  let after = null;
  let used = null;

  const candidates = mode === "catalog" ? CATALOG_CANDIDATES : SEARCH_CANDIDATES;
  console.log(mode === "catalog" ? `[mlit] mode=catalog` : `[mlit] mode=search term="${term}"`);

  for (let page = 1; page <= maxPages; page++) {
    let success = false, lastErr = null;

    for (const c of candidates) {
      try {
        const data = await gql(c.query, c.vars(after));
        const out = c.extract(data);
        if (!out || !Array.isArray(out.items)) throw new Error("extract failed");
        if (!used) used = c.name;

        acc.push(...out.items);
        after = out.pageInfo?.endCursor ?? null;

        console.log(`[mlit] page ${page}: got ${out.items.length} (total ${acc.length}) via ${c.name}`);
        if (!out.pageInfo?.hasNextPage) return { acc, used };

        success = true;
        break;
      } catch (e) {
        console.log(`HTTP error -> ${e?.message?.slice(0, 500)}`);
        console.log(`[mlit] shape failed: ${c.name} `);
        lastErr = e;
      }
    }

    if (!success) throw new Error(`All ${mode.toUpperCase()} shapes failed.`);
  }
  return { acc, used };
}

(async () => {
  try {
    const { acc, used } = await pageAll();
    console.log(`[mlit] used shape: ${used}`);
    acc.forEach((r, i) => console.log(`#${i + 1} ${r.name} [${r.id}]`));
    if (out) {
      fs.writeFileSync(out, JSON.stringify(acc, null, 2), "utf8");
      console.log(`[mlit] wrote ${acc.length} records to ${out}`);
    }
  } catch (e) {
    console.error("ERROR:", e.message || e);
    process.exit(2);
  }
})();
