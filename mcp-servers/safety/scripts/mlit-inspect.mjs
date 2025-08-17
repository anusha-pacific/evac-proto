// scripts/mlit-inspect.mjs
// Prints the actual field list for DataClass and a minimal sample of search results.
// Use this to learn which fields now carry coordinates.

import axios from "axios";

const ENDPOINT = "https://www.mlit-data.jp/api/v1/";
const API_KEY = process.env.MLIT_API_KEY;
if (!API_KEY) {
  console.error("Missing MLIT_API_KEY env var.");
  process.exit(1);
}

function errInfo(e) {
  if (e?.response?.data) return JSON.stringify(e.response.data, null, 2);
  return String(e?.message || e);
}

async function introspectDataClass() {
  const query = `
    query {
      __type(name: "DataClass") {
        name
        fields {
          name
          type {
            kind
            name
            ofType { kind name }
          }
        }
      }
    }`;
  const res = await axios.post(
    ENDPOINT,
    { query },
    { headers: { "Content-Type": "application/json", apikey: API_KEY } }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors, null, 2));
  return res.data.data.__type;
}

async function sampleSearch(term) {
  const query = `
    query($term: Any!) {
      search(term: $term, first: 1) {
        totalNumber
        searchResults {
          __typename
          ... on DataClass { id title theme }
        }
      }
    }`;
  const res = await axios.post(
    ENDPOINT,
    { query, variables: { term } },
    { headers: { "Content-Type": "application/json", apikey: API_KEY } }
  );
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors, null, 2));
  return res.data.data.search;
}

(async () => {
  try {
    console.log("=== DataClass fields ===");
    const t = await introspectDataClass();
    console.log(JSON.stringify(t, null, 2));

    console.log("\n=== Sample search (避難施設) ===");
    const s = await sampleSearch("避難施設");
    console.log(JSON.stringify(s, null, 2));

    console.log("\nNext: look for likely coordinate fields in the list above:");
    console.log("names like: lon, lng, lat, x, y, geometry, point, location, coords, centroid, etc.");
    console.log("Paste the field names here and I’ll update mlit-build-layers.mjs to include them.");
  } catch (e) {
    console.error("[inspect] ERROR:", errInfo(e));
    process.exit(2);
  }
})();
