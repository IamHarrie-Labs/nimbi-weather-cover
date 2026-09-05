/**
 * Consensus gate.
 *
 * Miners answer the same question in different shapes: one returns
 * `temperature_c` as a float, another embeds "23.4°C" in a sentence, a third
 * reports Fahrenheit. Before anything can decide whether a payout condition
 * is met, those have to become comparable numbers.
 *
 * This is the Track 2 scoring logic in its proper place — not judging miners,
 * but deciding whether their answers agree closely enough to move money.
 */

/** Unicode minus and friends, plus non-ASCII digit blocks, folded to ASCII. */
function normalizeText(s) {
  let out = "";
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if ("−–‒﹣－".includes(ch)) out += "-";
    else if (ch === " " || ch === " " || ch === " ") out += " ";
    else if (cp >= 0x0660 && cp <= 0x0669) out += String(cp - 0x0660);
    else if (cp >= 0x06f0 && cp <= 0x06f9) out += String(cp - 0x06f0);
    else if (cp >= 0xff10 && cp <= 0xff19) out += String(cp - 0xff10);
    else out += ch;
  }
  return out;
}

/**
 * Resolve `.` and `,` inside a digit run.
 *
 * Locale is inferred rather than assumed: when both separators appear the
 * rightmost is the decimal point, so `111.240,55` reads as European and
 * `111,240.55` as US. Repeated separators mean grouping.
 */
function canonicalDigits(run) {
  const lastDot = run.lastIndexOf(".");
  const lastComma = run.lastIndexOf(",");
  const dots = (run.match(/\./g) || []).length;
  const commas = (run.match(/,/g) || []).length;

  let decimal = null;
  if (dots > 0 && commas > 0) decimal = lastDot > lastComma ? "." : ",";
  else if (commas > 0) decimal = commas > 1 ? null
    : run.length - lastComma - 1 === 3 ? null : ",";
  else if (dots > 0) decimal = dots > 1 ? null : ".";

  let out = "";
  for (const ch of run) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === decimal) out += ".";
  }
  return out;
}

/** Every number in the text, with any unit that immediately follows it. */
export function extractNumbers(text) {
  const s = normalizeText(text);
  const out = [];
  const re = /(-?\d[\d.,]*)\s*(°\s*[CFK]|deg\s*[CFK]|[CFK]\b|celsius|fahrenheit|kelvin|%|mm|gwei|eth|usd)?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const cleaned = canonicalDigits(m[1].replace(/^-/, ""));
    if (!cleaned) continue;
    let value = parseFloat(cleaned);
    if (!Number.isFinite(value)) continue;
    if (m[1].startsWith("-")) value = -value;
    out.push({ value, unit: (m[2] || "").toLowerCase().replace(/[°\s]/g, "") });
  }
  return out;
}

/** Convert a temperature reading to Celsius. */
/**
 * Pull a temperature out of one miner's answer, whatever shape it arrived in.
 *
 * Prefers an explicitly keyed field (`temperature_c`, `temp`) over a bare
 * number, because weather payloads carry humidity, wind and coordinates that
 * would otherwise be mistaken for the reading.
 */
export function readTemperature(answer) {
  if (answer == null) return null;

  if (typeof answer === "object") {
    const hit = searchObject(answer);
    if (hit) return hit;
  }

  const raw = typeof answer === "string" ? answer : JSON.stringify(answer);
  return readFromText(raw);
}

/**
 * Keys that actually hold an air temperature, most specific first, paired with
 * the unit the name implies. Order matters: `temp_c` must beat `feelslike_c`,
 * and both must beat a bare `temp`.
 *
 * The alternative — take the first number you find — reads `clouds.all = 0`
 * from OpenWeatherMap and `chance_of_rain = 2` from WeatherAPI, and reports
 * 0°C and 2°C for a city that is actually 27°C. Both of those would have
 * cleared a "below 30°C" test and paid out wrongly.
 */
const TEMP_KEYS = [
  [/^(air_)?temperature_c$/i, "C"],
  [/^temp_c$/i, "C"],
  [/^(air_)?temperature_f$/i, "F"],
  [/^temp_f$/i, "F"],
  [/^(air_)?temperature_k$/i, "K"],
  [/^temp_k$/i, "K"],
  [/^apparent_temperature_c$/i, "C"],
  [/^feelslike_c$/i, "C"],
  [/^(air_)?temperature$/i, null],
  [/^temp$/i, null],
];

/** Keys that carry numbers which are emphatically not temperatures. */
const NOT_TEMP = /^(chance_of|clouds?|humidity|pressure|precip|wind|gust|vis|uv|cloud_cover|code|id|dt|timezone|lat|lon|latitude|longitude|epoch|sunrise|sunset|all|dewpoint|wetbulb|heatindex)/i;

/**
 * Infer the unit when the key does not state one.
 *
 * OpenWeatherMap returns `main.temp = 300.57` with no unit anywhere — that is
 * Kelvin, and reading it as Celsius would be a 273-degree error.
 */
function inferUnit(value) {
  if (value > 200) return "K";
  if (value > 60) return "F";
  return "C";
}

function toCelsius(value, unit) {
  if (unit === "K") return value - 273.15;
  if (unit === "F") return (value - 32) * (5 / 9);
  return value;
}

/** Depth-first search for the best-matching temperature key. */
function searchObject(obj, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== "object") return null;

  for (let rank = 0; rank < TEMP_KEYS.length; rank++) {
    const [pattern, unit] = TEMP_KEYS[rank];
    const found = findByKey(obj, pattern, depth);
    if (found) {
      const resolved = unit ?? inferUnit(found.value);
      return {
        celsius: toCelsius(found.value, resolved),
        source: `${found.key}(${resolved.toLowerCase()})`,
      };
    }
  }
  return null;
}

function findByKey(obj, pattern, depth) {
  if (depth > 4 || obj == null || typeof obj !== "object") return null;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (NOT_TEMP.test(key)) continue;
      if (pattern.test(key)) return { key, value };
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = findByKey(value, pattern, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** Last resort: pull a temperature out of a sentence. */
function readFromText(raw) {
  const m =
    raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C\b/i) ||
    raw.match(/(-?\d+(?:\.\d+)?)\s*degrees?\s*(?:celsius|c)\b/i);
  if (m) return { celsius: Number(m[1]), source: "text(c)" };

  const f = raw.match(/(-?\d+(?:\.\d+)?)\s*°?\s*F\b/i);
  if (f) return { celsius: toCelsius(Number(f[1]), "F"), source: "text(f)" };

  return null;
}

/**
 * Decide whether a set of miner readings is solid enough to move money on.
 *
 * The naive rule — every reading within tolerance of every other — sounds
 * strict and is actually useless. A survey of all five places we price found
 * one miner returning 40.50C for Cairo, London and Reykjavik alike: a
 * constant, not a measurement. Under the naive rule that single broken
 * reporter vetoes every settlement everywhere, and cover that can never pay
 * is not cover.
 *
 * So the rule here is the one distributed systems have always used: find the
 * cluster that agrees, and act on it if it is a real majority. Specifically —
 *
 *   - a reading joins the cluster if it sits within tolerance of the median
 *   - the cluster must hold a strict majority of the miners that answered
 *   - the cluster must have at least three members, so two miners repeating
 *     each other cannot carry a settlement
 *   - the cluster's own spread must still be within tolerance
 *
 * Excluded readings are not swept away: `outliers` names each one and the
 * counts reported on-chain always show the full denominator, so an audit sees
 * "5 of 6 agreed", never a quiet "6 agreed".
 *
 * When no majority forms — a genuine two-way split — this returns not ok, and
 * the contract holds. That is the refusal worth making: not "one source is
 * broken" but "the sources genuinely disagree and nobody can say who is right".
 */
export function agree(readings, toleranceC, minCluster = 3) {
  const usable = readings.filter((r) => Number.isFinite(r.celsius));
  if (usable.length === 0) {
    return { ok: false, reason: "no miner returned a readable temperature", readings, total: 0, agreeing: 0 };
  }
  if (usable.length === 1) {
    return {
      ok: false,
      reason: "only one miner answered — cannot cross-check a single source",
      value: usable[0].celsius,
      spread: 0,
      totalSpread: 0,
      agreeing: 1,
      total: 1,
      outliers: [],
      readings: usable,
    };
  }

  const median = (xs) => {
    const v = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const range = (xs) => Math.max(...xs) - Math.min(...xs);

  const all = usable.map((r) => r.celsius);
  const totalSpread = range(all);

  // The median is the anchor precisely because outliers cannot drag it: one
  // miner shouting 40.5C moves a mean by two degrees and a median by nothing.
  const anchor = median(all);
  const cluster = usable.filter((r) => Math.abs(r.celsius - anchor) <= toleranceC);
  const outliers = usable
    .filter((r) => !cluster.includes(r))
    .map((r) => ({ ...r, deviation: +(r.celsius - anchor).toFixed(2) }));

  const majority = cluster.length * 2 > usable.length;
  const enough = cluster.length >= minCluster;
  const clusterSpread = cluster.length ? range(cluster.map((r) => r.celsius)) : totalSpread;
  const tight = clusterSpread <= toleranceC;

  const plural = (n) => `${n} miner${n === 1 ? "" : "s"}`;

  // Order matters. When the miners split into camps no cluster forms, so both
  // the majority and the minimum-size checks fail together — but "they split
  // and nobody holds a majority" is the finding, and "fewer than three agreed"
  // is the same fact stated less usefully.
  let reason = null;
  if (!majority) {
    reason = `no majority: ${plural(cluster.length)} of ${usable.length} agree within ${toleranceC}°C, the rest are split`;
  } else if (!enough) {
    reason = `only ${plural(cluster.length)} agree within ${toleranceC}°C — need ${minCluster}`;
  } else if (!tight) {
    reason = `miners disagree by ${clusterSpread.toFixed(2)}°C, tolerance is ${toleranceC}°C`;
  }

  return {
    ok: enough && majority && tight,
    value: +(cluster.length ? median(cluster.map((r) => r.celsius)) : anchor).toFixed(2),
    spread: +clusterSpread.toFixed(2),
    totalSpread: +totalSpread.toFixed(2),
    tolerance: toleranceC,
    agreeing: cluster.length,
    total: usable.length,
    outliers,
    cluster,
    readings: usable,
    reason,
  };
}
