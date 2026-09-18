#!/usr/bin/env node

/**
 * Convert USCG SEM GPS almanacs into the compact JSON used by the browser app.
 *
 * Usage:
 *   node scripts/convert-almanacs.js [input-dir] [output-file] [year]
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const inputDir = path.resolve(process.argv[2] || "almanacs");
const outputFile = path.resolve(process.argv[3] || "data/almanacs-2026.json");
const year = Number(process.argv[4] || 2026);
const GPS_EPOCH_UNIX_SECONDS = Date.UTC(1980, 0, 6) / 1000;
const GPS_WEEK_SECONDS = 604800;
const GPS_UTC_OFFSET_SECONDS = 18; // Valid throughout 2026.

if (!Number.isInteger(year) || year < 1980) {
  throw new Error(`Invalid year: ${process.argv[4]}`);
}

function archiveDateFromName(fileName) {
  const match = /^(\d{3})\.al3$/i.exec(fileName);
  if (!match) return null;
  const dayOfYear = Number(match[1]);
  const dateMs = Date.UTC(year, 0, dayOfYear, 12);
  const date = new Date(dateMs);
  if (date.getUTCFullYear() !== year) return null;
  return { dayOfYear, unixSeconds: dateMs / 1000 };
}

function expandGpsWeek(moduloWeek, archiveUnixSeconds) {
  const approximateWeek =
    (archiveUnixSeconds + GPS_UTC_OFFSET_SECONDS - GPS_EPOCH_UNIX_SECONDS) /
    GPS_WEEK_SECONDS;
  return moduloWeek + 1024 * Math.round((approximateWeek - moduloWeek) / 1024);
}

function finiteNumber(value, label, fileName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${fileName}: invalid ${label}: ${value}`);
  }
  return number;
}

function parseSem(text, fileName, archiveUnixSeconds) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) throw new Error(`${fileName}: incomplete SEM file`);
  const recordCount = Number(lines[0].split(/\s+/)[0]);
  const epoch = lines[1].split(/\s+/);
  const moduloWeek = finiteNumber(epoch[0], "GPS week", fileName);
  const toa = finiteNumber(epoch[1], "time of applicability", fileName);
  const fullWeek = expandGpsWeek(moduloWeek, archiveUnixSeconds);
  const referenceUnixSeconds =
    GPS_EPOCH_UNIX_SECONDS + fullWeek * GPS_WEEK_SECONDS + toa - GPS_UTC_OFFSET_SECONDS;

  const records = [];
  let line = 2;
  for (let index = 0; index < recordCount; index += 1) {
    if (line + 7 >= lines.length) {
      throw new Error(`${fileName}: expected ${recordCount} satellite records`);
    }

    const prn = finiteNumber(lines[line], "PRN", fileName);
    const orbit1 = lines[line + 3].split(/\s+/).map(Number);
    const orbit2 = lines[line + 4].split(/\s+/).map(Number);
    const orbit3 = lines[line + 5].split(/\s+/).map(Number);
    const health = finiteNumber(lines[line + 6], "health", fileName);

    if (
      orbit1.length !== 3 ||
      orbit2.length !== 3 ||
      orbit3.length !== 3 ||
      [...orbit1, ...orbit2, ...orbit3].some((value) => !Number.isFinite(value))
    ) {
      throw new Error(`${fileName}: malformed orbital record for PRN ${prn}`);
    }

    // [PRN, health, eccentricity, inclination offset, right ascension rate,
    //  sqrt(A), right ascension, argument of perigee, mean anomaly]
    records.push([
      prn,
      health,
      orbit1[0],
      orbit1[1],
      orbit1[2],
      orbit2[0],
      orbit2[1],
      orbit2[2],
      orbit3[0],
    ]);
    line += 8;
  }

  return { referenceUnixSeconds, fullWeek, toa, records };
}

const files = fs
  .readdirSync(inputDir)
  .map((fileName) => ({ fileName, archive: archiveDateFromName(fileName) }))
  .filter((entry) => entry.archive)
  .sort((a, b) => a.archive.dayOfYear - b.archive.dayOfYear);

if (files.length === 0) throw new Error(`No NNN.al3 files found in ${inputDir}`);

const seen = new Set();
const almanacs = [];
for (const { fileName, archive } of files) {
  const text = fs.readFileSync(path.join(inputDir, fileName), "utf8");
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  if (seen.has(hash)) continue;
  seen.add(hash);

  const parsed = parseSem(text, fileName, archive.unixSeconds);
  almanacs.push([
    parsed.referenceUnixSeconds,
    parsed.fullWeek,
    parsed.toa,
    parsed.records,
  ]);
}

almanacs.sort((a, b) => a[0] - b[0]);
const output = {
  version: 1,
  year,
  gpsUtcOffsetSeconds: GPS_UTC_OFFSET_SECONDS,
  fields: [
    "prn",
    "health",
    "eccentricity",
    "inclinationOffsetSemiCircles",
    "rightAscensionRateSemiCirclesPerSecond",
    "sqrtSemiMajorAxisMeters",
    "rightAscensionSemiCircles",
    "argumentOfPerigeeSemiCircles",
    "meanAnomalySemiCircles",
  ],
  sourceFileCount: files.length,
  almanacs,
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(output));
const bytes = fs.statSync(outputFile).size;
console.log(
  `Wrote ${almanacs.length} unique almanacs from ${files.length} files to ${outputFile} (${bytes.toLocaleString()} bytes)`,
);
