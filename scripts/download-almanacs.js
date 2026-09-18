#!/usr/bin/env node

/** Download missing daily USCG SEM almanacs for a calendar year. */

const fs = require("node:fs");
const path = require("node:path");

const year = Number(process.argv[2] || 2026);
const outputDirectory = path.resolve(process.argv[3] || "almanacs");
const baseUrl = `https://www.navcen.uscg.gov/sites/default/files/gps/almanac/${year}/Sem`;

if (!Number.isInteger(year) || year < 1980) throw new Error(`Invalid year: ${year}`);

function daysInYear(value) {
  return new Date(Date.UTC(value, 1, 29)).getUTCMonth() === 1 ? 366 : 365;
}

function utcDayOfYear(date) {
  return Math.floor((date - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
}

const now = new Date();
const lastDay = year < now.getUTCFullYear()
  ? daysInYear(year)
  : year === now.getUTCFullYear()
    ? utcDayOfYear(now)
    : 0;

async function main() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  let downloaded = 0;
  let alreadyPresent = 0;
  let unavailable = 0;

  for (let day = 1; day <= lastDay; day += 1) {
    const dayText = String(day).padStart(3, "0");
    const destination = path.join(outputDirectory, `${dayText}.al3`);
    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
      alreadyPresent += 1;
      continue;
    }

    const response = await fetch(`${baseUrl}/${dayText}.al3`, {
      headers: { "User-Agent": "gps-gdop-explorer almanac updater" },
    });
    if (response.status === 404) {
      console.warn(`${dayText}.al3 is not available yet`);
      unavailable += 1;
      continue;
    }
    if (!response.ok) throw new Error(`${dayText}.al3: HTTP ${response.status}`);

    const temporary = `${destination}.part`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, destination);
    console.log(`Downloaded ${dayText}.al3`);
    downloaded += 1;
  }

  console.log({ year, throughDay: lastDay, downloaded, alreadyPresent, unavailable });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
