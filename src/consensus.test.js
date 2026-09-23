/**
 * Regression tests for the consensus rule and the temperature parser.
 *
 * Uses node's built-in test runner (`node --test`), so there is no new
 * dependency to install and nothing here needs network access. Several
 * cases are taken directly from real data this project produced (the
 * five-city chainsight-oracle survey, the OpenWeatherMap Kelvin bug) rather
 * than invented, so a regression here is a regression against something
 * that actually happened once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { agree, readTemperature, extractNumbers } from "./consensus.js";

const reading = (slug, celsius) => ({ slug, celsius });

// ---------------------------------------------------------------- agree()

test("agree: full agreement pays", () => {
  const r = agree([reading("a", 20), reading("b", 20.5), reading("c", 21)], 2);
  assert.equal(r.ok, true);
  assert.equal(r.agreeing, 3);
  assert.equal(r.total, 3);
  assert.equal(r.outliers.length, 0);
});

test("agree: real chainsight-oracle data — majority excludes the constant reading", () => {
  // Cairo, from the committed survey (build/survey.json): five real miners
  // clustered around 28C, chainsight-oracle reported 40.5C.
  const readings = [
    reading("skywire-weather-check", 28.5),
    reading("verity-current-weather", 28.8),
    reading("openweathermap", 27.42),
    reading("weatherapi", 27.9),
    reading("isobar-weather", 28.7),
    reading("chainsight-oracle", 40.5),
  ];
  const r = agree(readings, 2);
  assert.equal(r.ok, true, "five of six agreeing should settle, not hold");
  assert.equal(r.agreeing, 5);
  assert.equal(r.total, 6);
  assert.equal(r.outliers.length, 1);
  assert.equal(r.outliers[0].slug, "chainsight-oracle");
});

test("agree: naive all-agree rule would have made this un-settleable — majority rule doesn't", () => {
  // Same data as above, tolerance tight enough that the FULL spread (40.5 - 27.42 = 13.08)
  // would fail a naive "everyone within tolerance" rule, but the cluster's own
  // spread is well within it.
  const readings = [
    reading("a", 28.5), reading("b", 28.8), reading("c", 27.42),
    reading("d", 27.9), reading("e", 28.7), reading("outlier", 40.5),
  ];
  const r = agree(readings, 2);
  assert.equal(r.ok, true);
  assert.ok(r.totalSpread > 2, "the full spread should exceed tolerance");
  assert.ok(r.spread <= 2, "but the cluster's own spread should not");
});

test("agree: a genuine 3-3 split holds, and says so specifically", () => {
  const readings = [
    reading("a", 10), reading("b", 10.1), reading("c", 10.2),
    reading("d", 30), reading("e", 30.1), reading("f", 30.2),
  ];
  const r = agree(readings, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no majority/);
});

test("agree: cluster below minimum size holds even with a majority direction", () => {
  // Two agree, one is out on its own: 2 of 3 is a majority, but minCluster
  // defaults to 3, so a pair alone can't carry a settlement.
  const readings = [reading("a", 20), reading("b", 20.2), reading("c", 40)];
  const r = agree(readings, 2);
  assert.equal(r.ok, false);
  assert.match(r.reason, /only 2 miners agree/);
});

test("agree: a majority cluster can form and still be too spread out to trust", () => {
  // Median of [8, 12, 16, 100] is 14. All of 8, 12, 16 sit within 6 of that
  // (a majority, and enough of them) but they span 8 to 16 among themselves,
  // wider than the 6-degree tolerance — a real majority that still shouldn't
  // be trusted to settle on.
  const readings = [reading("a", 8), reading("b", 12), reading("c", 16), reading("outlier", 100)];
  const r = agree(readings, 6, 3);
  assert.equal(r.agreeing, 3, "a 3-member cluster should have formed");
  assert.equal(r.ok, false);
  assert.match(r.reason, /disagree by/);
});

test("agree: zero readable miners", () => {
  const r = agree([], 2);
  assert.equal(r.ok, false);
  assert.equal(r.total, 0);
  assert.match(r.reason, /no miner returned/);
});

test("agree: a single miner cannot cross-check itself", () => {
  const r = agree([reading("only-one", 22)], 2);
  assert.equal(r.ok, false);
  assert.equal(r.total, 1);
  assert.match(r.reason, /only one miner/);
});

test("agree: unreadable readings (non-finite celsius) are filtered before counting", () => {
  const readings = [reading("a", 20), reading("b", 20.5), reading("bad", NaN)];
  const r = agree(readings, 2);
  assert.equal(r.total, 2);
});

// ---------------------------------------------------------------- readTemperature()

test("readTemperature: a keyed field beats a same-shaped decoy", () => {
  // The real bug this guards: openweathermap's clouds.all and weatherapi's
  // chance_of_rain are plausible-looking numbers that are not the temperature.
  const t = readTemperature({ temp_c: 27.9, clouds: { all: 0 } });
  assert.equal(t.celsius, 27.9);
});

test("readTemperature: feelslike_c does not outrank temp_c", () => {
  const t = readTemperature({ feelslike_c: 30.1, temp_c: 27.9 });
  assert.equal(t.celsius, 27.9);
});

test("readTemperature: OpenWeatherMap's unitless Kelvin is inferred correctly", () => {
  // The actual bug: main.temp = 300.57 with no unit key anywhere. Reading it
  // as Celsius is a 273-degree error.
  const t = readTemperature({ main: { temp: 300.57 } });
  assert.ok(Math.abs(t.celsius - 27.42) < 0.01, `expected ~27.42C, got ${t.celsius}`);
});

test("readTemperature: chance_of_rain is excluded even though it's a plausible number", () => {
  const t = readTemperature({ chance_of_rain: 2, temp_c: 24.4 });
  assert.equal(t.celsius, 24.4);
});

test("readTemperature: falls through to text when there's no structured field", () => {
  const t = readTemperature("Right now it's 23.4°C in Cairo.");
  assert.equal(t.celsius, 23.4);
});

test("readTemperature: Fahrenheit in text is converted", () => {
  const t = readTemperature("It's 98.6°F outside.");
  assert.ok(Math.abs(t.celsius - 37) < 0.01);
});

test("readTemperature: no temperature anywhere returns null, not a guess", () => {
  const t = readTemperature({ humidity: 80, wind_kph: 12 });
  assert.equal(t, null);
});

// ---------------------------------------------------------------- extractNumbers()

test("extractNumbers: US-style thousands vs European decimal comma are told apart", () => {
  assert.equal(extractNumbers("111,240.55")[0].value, 111240.55);
  assert.equal(extractNumbers("111.240,55")[0].value, 111240.55);
});

test("extractNumbers: unicode minus and fullwidth digits normalize to ASCII", () => {
  const out = extractNumbers("１０ degrees"); // fullwidth "10"
  assert.equal(out[0].value, 10);
});
