#!/usr/bin/env node

/** Download missing daily USCG SEM almanacs for one or more calendar years. */

const fs = require("node:fs");
const path = require("node:path");

const years = (process.argv.slice(2).length ? process.argv.slice(2) : [2024, 2025, 2026]).map(Number);
const outputRoot = path.resolve("almanacs");
const CONCURRENCY = 8;

if (years.some((year) => !Number.isInteger(year) || year < 1980)) {
  throw new Error(`Invalid years: ${process.argv.slice(2).join(", ")}`);
}

function daysInYear(value) {
  return new Date(Date.UTC(value, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
}

function utcDayOfYear(date) {
  return Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

async function downloadYear(year) {
  const now = new Date();
  const lastDay = year < now.getUTCFullYear()
    ? daysInYear(year)
    : year === now.getUTCFullYear()
      ? utcDayOfYear(now)
      : 0;
  const outputDirectory = path.join(outputRoot, String(year));
  const baseUrl = `https://www.navcen.uscg.gov/sites/default/files/gps/almanac/${year}/Sem`;
  fs.mkdirSync(outputDirectory, { recursive: true });
  const totals = { year, throughDay: lastDay, downloaded: 0, alreadyPresent: 0, unavailable: 0 };

  async function downloadDay(day) {
    const dayText = String(day).padStart(3, "0");
    const destination = path.join(outputDirectory, `${dayText}.al3`);
    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
      totals.alreadyPresent += 1;
      return;
    }

    const response = await fetch(`${baseUrl}/${dayText}.al3`, {
      headers: { "User-Agent": "gps-gdop-explorer almanac updater" },
    });
    if (response.status === 404) {
      console.warn(`${year}/${dayText}.al3 is not available yet`);
      totals.unavailable += 1;
      return;
    }
    if (!response.ok) throw new Error(`${year}/${dayText}.al3: HTTP ${response.status}`);

    const temporary = `${destination}.part`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, destination);
    console.log(`Downloaded ${year}/${dayText}.al3`);
    totals.downloaded += 1;
  }

  for (let first = 1; first <= lastDay; first += CONCURRENCY) {
    const batch = Array.from(
      { length: Math.min(CONCURRENCY, lastDay - first + 1) },
      (_, offset) => downloadDay(first + offset),
    );
    await Promise.all(batch);
  }
  console.log(totals);
}

async function main() {
  for (const year of years) await downloadYear(year);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
