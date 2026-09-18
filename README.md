# GPS GDOP Explorer

A static Leaflet/Plotly application that calculates GPS geometric dilution of precision from USCG SEM almanacs.

The application runs entirely in the browser and can be hosted directly on GitHub Pages. Satellite geometry calculations run in a Web Worker so long time ranges do not block the interface.

Results are shown as both a UTC time-series and a seamless daily heatmap whose rows are dates and whose columns are time-of-day samples.
The threshold-controlled polar sky view shows every visible satellite position from samples above the selected GDOP value. Zooming the time-series synchronizes the heatmap's visible days; changing the heatmap's day range synchronizes the time-series, while its independent time-of-day zoom further filters the polar view.
The default calculation window is the previous seven UTC days with a 10° elevation mask. Use **Reset sky view** to restore the full polar view after zooming.

After calculating a location, the global map can process either the first or last 24 hours of the selected range. It evaluates maximum GDOP at the centers of all 41,162 resolution 3 H3 cells using the selected time interval and elevation mask. Satellite propagation runs once per time step in a dedicated worker, while a SIMD WebAssembly kernel evaluates the receiver geometry globally. At lower map zooms, resolution 3 results are aggregated into resolution 0–2 parents using the maximum child value; the overlay repeats across wrapped world copies.

The adjusted-constellation map reuses the exact period, interval, and elevation mask of the most recent global baseline. Add one or more PRNs with signed along-orbit offsets in seconds, then apply them to generate a second map on the same GDOP color scale. Positive offsets advance a satellite's mean anomaly by `mean motion × offset`; negative offsets move it backward. The adjustment is applied to that PRN in every almanac selected during the period.

## Build the compact dataset

Download any currently available almanacs that are not already present, then rebuild the compact dataset:

```bash
npm run build
```

Or run only the conversion step:

```bash
npm run build:data
```

The converter reads `almanacs/<year>/NNN.al3`, removes fields that are not needed for satellite geometry, deduplicates byte-identical snapshots, expands modulo-1024 GPS weeks using the archive date, and writes `data/almanacs.json`.

Optional converter arguments are the input root and output file:

```bash
node scripts/convert-almanacs.js almanacs data/almanacs.json
```

## Run locally

The browser must load the files over HTTP rather than directly from `file://`:

```bash
npm run serve
```

Open <http://localhost:8000/>. The map tiles and the Leaflet and Plotly libraries require an internet connection; the almanac calculations run locally in a Web Worker.

The compiled WebAssembly module is committed to the repository. To rebuild it after changing `assembly/global-gdop.ts`, install the development dependencies and run:

```bash
npm install
npm run build:wasm
```

## Publish with GitHub Pages

The workflow in `.github/workflows/pages.yml` rebuilds and deploys the site whenever `main` changes, can be run manually, and checks NAVCEN for new almanacs once per day. When a new file is available, the workflow commits the source almanac and regenerated compact JSON before deploying.

After pushing the repository, open **Settings → Pages** on GitHub and select **GitHub Actions** as the publishing source. The next workflow run will publish the site.

## Data source

SEM almanacs for 2024–2026 are downloaded from the [U.S. Coast Guard Navigation Center](https://www.navcen.uscg.gov/gps-nanus-almanacs-opsadvisories-sof). The SEM field definitions are documented in ICD-GPS-240 and ICD-GPS-870. This project is not affiliated with or endorsed by NAVCEN, the U.S. Coast Guard, or the U.S. government.

## Calculation notes

- UTC is converted using the 18-second GPS−UTC offset applicable throughout 2024–2026.
- Each timestamp uses the almanac whose reference epoch is closest to it.
- Timestamps are grouped by almanac, and each satellite is propagated across a group's typed time array before GDOP matrices are inverted.
- Visible sky positions are returned in a compact per-sample index with azimuth and elevation stored to 0.01° for interactive threshold filtering.
- The global map samples H3 cell centers; it does not guarantee the maximum everywhere inside each cell. Cells without valid four-satellite geometry are shown in dark gray.
- Satellites with a nonzero SEM health value or below the selected elevation mask are excluded.
- Almanac orbits are intentionally low precision and are appropriate for geometry/availability analysis, not precision positioning.
