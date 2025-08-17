// scripts/mlit-list.mjs
// MLIT GraphQL lister/searcher with adaptive schema + typed search extraction.
// Requires: env MLIT_API_KEY

import axios from "axios";
import fs from "node:fs";

const ENDPOINT = "https://www.mlit-data.jp/api/v1/";
const API_KEY = process.env.MLIT_API_KEY;
if (!API_KEY) {
  console.error("Missing MLIT_API_KEY env var.");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ""), true];
  })
);

const mode = (args.mode || "catalog").toString();
const term = args.term ?? "";
const first = Number(args.first || 50);
const out = args.out || "";

// ---------- GraphQL helpers ----------
async function gql(query, variables) {
  const res = await axios.post(
    ENDPOINT,
    { query, variables },
    { headers: { "Content-Type": "application/json", apikey: API_KEY } }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors, null, 2));
  return res.data.data;
}

async function introspectType(typeName) {
  const q = `
    query($name:String!){
      __type(name:$name){
        name
        kind
        fields {
          name
          type {
            kind name
            ofType { kind name ofType { kind name } }
          }
        }
      }
    }`;
  const d = await gql(q, { name: typeName });
  return d.__type;
}

function unwrapType(t) {
  let cur = t;
  while (cur && !cur.name && cur.ofType) cur = cur.ofType;
  return cur ? { kind: cur.kind, name: cur.name } : { kind: t.kind, name: t.name };
}

// Prefer readable fields if present
const PREFERRED_FIELDS = [
  "id","datasetId","name","datasetName","title","description","summary",
  "publisher","theme","tags","prefecture","municipality","url","updatedAt","createdAt"
];

// Build safe selection for an OBJECT type.
// Scalar/enum: include if matches preferred list (or guessed fallbacks).
// Nested OBJECT/LIST: include minimally as __typename.
async function buildSafeSelection(typeName, extraPrefs = []) {
  const info = await introspectType(typeName);
  if (!info || info.kind !== "OBJECT" || !info.fields) return "{ __typename }";

  const pref = [...extraPrefs, ...PREFERRED_FIELDS];
  const avail = new Map(info.fields.map(f => [f.name, f]));
  const chosen = new Set(["__typename"]);

  // include preferred scalar/enum fields
  for (const fname of pref) {
    const f = avail.get(fname);
    if (!f) continue;
    const u = unwrapType(f.type);
    if (u.kind === "SCALAR" || u.kind === "ENUM") chosen.add(fname);
  }

  // if still sparse, add up to 4 more scalar/enum fields
  for (const f of info.fields) {
    if (chosen.size >= 6) break; // __typename + ~5
    const u = unwrapType(f.type);
    if ((u.kind === "SCALAR" || u.kind === "ENUM") && !chosen.has(f.name)) {
      chosen.add(f.name);
    }
  }

  // minimal nested marks
  for (const f of info.fields) {
    const u = unwrapType(f.type);
    if (u.kind === "OBJECT" || u.kind === "LIST") {
      chosen.add(`${f.name} { __typename }`);
    }
  }

  const lines = Array.from(chosen).map(x => (x.includes("{") ? x : `  ${x}`));
  const nested = lines.some(l => l.includes("{"));
  if (nested) {
    const direct = lines.filter(l => !l.includes("{")).join("\n");
    const nestedParts = lines.filter(l => l.includes("{")).join("\n");
    return `{
  ${direct}
  ${nestedParts}
}`;
  } else {
    return `{
  ${lines.join("\n")}
}`;
  }
}

// ---------- Catalog ----------
async function runCatalog() {
  console.log(`[mlit] mode=catalog`);

  const q1 = `query { dataCatalog { __typename } }`;
  const d1 = await gql(q1, {});
  const count = (d1.dataCatalog || []).length;
  console.log(`[mlit] dataCatalog count: ${count}`);
  if (!count) return [];

  const selDataset = await buildSafeSelection("DatasetInfoClass");
  const q2 = `
    query {
      dataCatalog {
        datasets ${selDataset}
      }
    }`;
  const d2 = await gql(q2, {});
  const rows = [];
  for (const cat of d2.dataCatalog || []) {
    for (const ds of cat.datasets || []) rows.push(ds);
  }
  console.log(`[mlit] flattened datasets: ${rows.length}`);
  return rows;
}

// ---------- Search (typed extraction) ----------
async function runSearch(term, first) {
  console.log(`[mlit] mode=search term="${term}" first=${first}`);

  // Probe
  const qProbe = `query($term: Any!, $first: Int!){
    search(term:$term, first:$first){
      totalNumber
      searchResults { __typename }
    }
  }`;
  const dProbe = await gql(qProbe, { term, first });
  const total = dProbe.search?.totalNumber ?? 0;
  const typenames = (dProbe.search?.searchResults || []).map(r => r?.__typename).filter(Boolean);
  const typeSet = [...new Set(typenames)];
  console.log(`[mlit] totalNumber=${total}; result types: ${typeSet.join(", ") || "(none)"}`);

  if (!typeSet.length) return dProbe.search;

  // Build inline fragments for each result type
  const fragments = [];
  for (const tname of typeSet) {
    const sel = await buildSafeSelection(tname);
    // strip outer braces from sel
    const inner = sel.trim().replace(/^\{\s*|\s*\}$/g, "");
    fragments.push(`... on ${tname} {
  ${inner}
}`);
  }

  const q = `query($term: Any!, $first: Int!){
    search(term:$term, first:$first){
      totalNumber
      searchResults {
        ${fragments.join("\n        ")}
      }
    }
  }`;

  const d = await gql(q, { term, first });
  return d.search;
}

// ---------- Main ----------
(async () => {
  try {
    let outData = null;

    if (mode === "catalog") {
      outData = await runCatalog();
    } else if (mode === "search") {
      if (!term) throw new Error(`--term is required for --mode=search`);
      outData = await runSearch(term.toString(), first);
    } else {
      throw new Error(`Unknown --mode=${mode}. Use "catalog" or "search".`);
    }

    if (out) {
      fs.writeFileSync(out, JSON.stringify(outData, null, 2), "utf8");
      console.log(`[mlit] wrote output to ${out}`);
    } else {
      console.log(JSON.stringify(outData, null, 2));
    }
  } catch (e) {
    const msg = e?.response?.data ?? e?.message ?? e;
    console.error("ERROR:", typeof msg === "string" ? msg : JSON.stringify(msg, null, 2));
    process.exit(2);
  }
})();
