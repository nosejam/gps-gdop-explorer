#!/usr/bin/env node

const assert = require("node:assert/strict");

global.window = {};
require("../almanac-history.js");

const { wrap360, wrap180, unwrapAngles, deriveOrbit } = window.AlmanacHistory;

assert.equal(wrap360(-1), 359);
assert.equal(wrap360(361), 1);
assert.equal(wrap180(181), -179);
assert.equal(wrap180(-181), 179);
assert.deepEqual(unwrapAngles([358, 359, 1, 2]), [358, 359, 361, 362]);

const sample = [2, 0, 0.01, 0, -2e-9, 5153.8, 0.5, 0.25, 0.5];
const orbit = deriveOrbit(sample);
const expectedAxis = sample[5] ** 2;
const expectedPeriod = 2 * Math.PI * Math.sqrt(expectedAxis ** 3 / 3.986005e14);
assert.equal(orbit.semiMajorAxisMeters, expectedAxis);
assert.ok(Math.abs(orbit.orbitalPeriodSeconds - expectedPeriod) < 1e-9);
assert.equal(orbit.meanArgumentOfLatitudeDegrees, 135);

const data = require("../data/almanacs.json");
const rangeStart = Date.parse("2026-03-20T00:00:00Z") / 1000;
const rangeEnd = Date.parse("2026-05-31T23:59:59Z") / 1000;

function largestAxisStep(prn) {
  const records = data.almanacs
    .filter((almanac) => almanac[0] >= rangeStart && almanac[0] <= rangeEnd)
    .map((almanac) => ({ unixSeconds: almanac[0], satellite: almanac[3].find((entry) => entry[0] === prn) }))
    .filter((entry) => entry.satellite)
    .map((entry) => ({ unixSeconds: entry.unixSeconds, axis: entry.satellite[5] ** 2 }));
  return records.slice(1).reduce((largest, record, index) => {
    const step = record.axis - records[index].axis;
    return Math.abs(step) > Math.abs(largest.step) ? { step, unixSeconds: record.unixSeconds } : largest;
  }, { step: 0, unixSeconds: 0 });
}

const prn2 = largestAxisStep(2);
const prn3 = largestAxisStep(3);
assert.ok(prn2.unixSeconds >= Date.parse("2026-04-01T00:00:00Z") / 1000);
assert.ok(prn2.unixSeconds < Date.parse("2026-05-01T00:00:00Z") / 1000);
assert.ok(Math.abs(prn2.step) > 1000, "PRN 02 April axis change should be visually obvious");
assert.ok(Math.abs(prn3.step) < 100, "PRN 03 should provide a stable comparison in this range");

console.log("Almanac History math and 2026 PRN 02/03 sanity checks passed.");
