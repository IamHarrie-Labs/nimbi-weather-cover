/**
 * WEATHER_CHECK miners, with the exact call shape each one needs.
 *
 * `ask_direct` will not infer an endpoint — it fails with "subnet_id and
 * endpoint are required". And each miner declares its own parameter names:
 * one wants `location`, another `q`, another `lat`/`lon`. The engine's LLM
 * router papers over this for plain `ask`, but plain `ask` also kept landing
 * on the same miner every time, which is useless for a consensus read.
 *
 * So the shapes live here, taken from `input_schema` in GET /api/miners.
 * Anything not declared by a miner is invisible to it, so each payload sends
 * only the keys that miner actually understands.
 */

/** @typedef {{lat:number, lon:number, name:string, country?:string}} Place */

/** Places we can price. Keep the list short and real. */
export const PLACES = {
  cairo: { name: "Cairo", country: "EG", lat: 30.0444, lon: 31.2357 },
  lagos: { name: "Lagos", country: "NG", lat: 6.5244, lon: 3.3792 },
  london: { name: "London", country: "GB", lat: 51.5072, lon: -0.1276 },
  singapore: { name: "Singapore", country: "SG", lat: 1.3521, lon: 103.8198 },
  reykjavik: { name: "Reykjavik", country: "IS", lat: 64.1466, lon: -21.9426 },
};

/**
 * Each entry knows how to address one miner for a current-conditions read.
 * `payload(place)` returns only keys that miner declares.
 */
export const WEATHER_MINERS = [
  {
    id: "7304",
    slug: "skywire-weather-check",
    endpoint: "/weather",
    method: "GET",
    payload: (p) => ({ location: p.name, question: `What is the current temperature in ${p.name}?` }),
  },
  {
    id: "9006",
    slug: "verity-current-weather",
    endpoint: "/weather",
    method: "GET",
    payload: (p) => ({ latitude: p.lat, longitude: p.lon, location: p.name }),
  },
  {
    id: "211",
    slug: "openweathermap",
    endpoint: "/weather",
    method: "GET",
    payload: (p) => ({ lat: p.lat, lon: p.lon, q: p.country ? `${p.name},${p.country}` : p.name }),
  },
  {
    id: "212",
    slug: "weatherapi",
    endpoint: "/current",
    method: "GET",
    payload: (p) => ({ q: p.name }),
  },
  {
    id: "20260826",
    slug: "isobar-weather",
    endpoint: "/weather",
    method: "GET",
    payload: (p) => ({ q: p.name }),
  },
  {
    id: "302",
    slug: "chainsight-oracle",
    endpoint: "/wcheck",
    method: "GET",
    payload: (p) => ({ q: p.name, city: p.name, location: p.name }),
  },
];

export function place(key) {
  const p = PLACES[String(key).toLowerCase()];
  if (!p) throw new Error(`unknown place "${key}" — known: ${Object.keys(PLACES).join(", ")}`);
  return p;
}
