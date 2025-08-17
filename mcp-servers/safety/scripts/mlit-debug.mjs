// scripts/mlit-debug.mjs
import axios from "axios";

const ENDPOINT = "https://www.mlit-data.jp/api/v1/";
const API_KEY = process.env.MLIT_API_KEY;
if (!API_KEY) {
  console.error("Missing MLIT_API_KEY env var.");
  process.exit(1);
}

// run a single GraphQL query and print everything we can
async function run(name, query, variables = {}) {
  try {
    const res = await axios.post(
      ENDPOINT,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          // try both common header keys; server will ignore extras
          "x-api-key": API_KEY,
          "apikey": API_KEY,
        },
        validateStatus: () => true, // don't throw, let us inspect
      }
    );
    console.log(`\n=== TEST: ${name} ===`);
    console.log("status:", res.status);
    if (typeof res.data === "string") {
      console.log("body (string):", res.data.slice(0, 500));
    } else {
      console.log("body (json):", JSON.stringify(res.data, null, 2).slice(0, 4000));
    }
  } catch (e) {
    console.log(`\n=== TEST: ${name} ===`);
    console.log("AXIOS ERROR:", e?.message);
    if (e?.response) {
      console.log("status:", e.response.status);
      console.log("data:", e.response.data);
    }
  }
}

(async () => {
  // 0) sanity
  await run("simple typename", `query { __typename }`);

  // 1) try full introspection (often disabled in prod; if disabled we’ll see a clear error)
  await run("introspection", `
    query {
      __schema {
        queryType { name }
        types { name kind }
      }
    }
  `);

  // 2) probe obvious roots by name (common patterns)
  await run("probe dataCatalog only", `query { dataCatalog { __typename } }`);
  await run("probe datasets under dataCatalog", `
    query {
      dataCatalog {
        datasets {
          __typename
        }
      }
    }
  `);

  // 3) minimal search shapes (with first because the server complained it is required)
  await run("probe search minimal", `
    query($term: Any!, $first: Int!) {
      search(term: $term, first: $first) { __typename }
    }`,
    { term: "test", first: 1 }
  );

  await run("probe search datasets nodes", `
    query($term: Any!, $first: Int!) {
      search(term: $term, first: $first) {
        datasets {
          nodes { id name title datasetId datasetName }
        }
      }
    }`,
    { term: "test", first: 1 }
  );

  // 4) alternative naming guesses often used by data portals
  await run("probe catalog", `query { catalog { __typename } }`);
  await run("probe datasets at root", `query { datasets(first: 1) { __typename } }`);
  await run("probe listDatasets", `query { listDatasets(first: 1) { __typename } }`);
})();
