# GPS GDOP Explorer

A static Leaflet/Plotly application that calculates GPS geometric dilution of precision from USCG SEM almanacs.

The application runs entirely in the browser and can be hosted directly on GitHub Pages. Satellite geometry calculations run in a Web Worker so long time ranges do not block the interface.

Results are shown as both a UTC time-series and a seamless daily heatmap whose rows are dates and whose columns are time-of-day samples.
The threshold-controlled polar sky view shows every visible satellite position from samples above the selected GDOP value. Zooming the time-series synchronizes the heatmap's visible days; changing the heatmap's day range synchronizes the time-series, while its independent time-of-day zoom further filters the polar view.
The default calculation window is the previous seven UTC days with a 10° elevation mask. Use **Reset sky view** to restore the full polar view after zooming.

## Build the compact dataset

Download any currently available almanacs that are not already present, then rebuild the compact dataset:

```bash
npm run build
```

Or run only the conversion step:

```bash
npm run build:data
```

The converter reads `almanacs/NNN.al3`, removes fields that are not needed for satellite geometry, deduplicates byte-identical snapshots, expands modulo-1024 GPS weeks using the archive date, and writes `data/almanacs-2026.json`.

Optional arguments are the input directory, output file, and year:

```bash
node scripts/convert-almanacs.js almanacs data/almanacs-2026.json 2026
```

## Run locally

The browser must load the files over HTTP rather than directly from `file://`:

```bash
npm run serve
```

Open <http://localhost:8000/>. The map tiles and the Leaflet and Plotly libraries require an internet connection; the almanac calculations run locally in a Web Worker.

## Publish with GitHub Pages

The workflow in `.github/workflows/pages.yml` rebuilds and deploys the site whenever `main` changes, can be run manually, and checks NAVCEN for new almanacs once per day. When a new file is available, the workflow commits the source almanac and regenerated compact JSON before deploying.

After pushing the repository, open **Settings → Pages** on GitHub and select **GitHub Actions** as the publishing source. The next workflow run will publish the site.

## Data source

SEM almanacs are downloaded from the [U.S. Coast Guard Navigation Center](https://www.navcen.uscg.gov/gps-nanus-almanacs-opsadvisories-sof). The SEM field definitions are documented in ICD-GPS-240 and ICD-GPS-870. This project is not affiliated with or endorsed by NAVCEN, the U.S. Coast Guard, or the U.S. government.

## Calculation notes

- UTC is converted using the 18-second GPS−UTC offset applicable during 2026.
- Each timestamp uses the almanac whose reference epoch is closest to it.
- Timestamps are grouped by almanac, and each satellite is propagated across a group's typed time array before GDOP matrices are inverted.
- Visible sky positions are returned in a compact per-sample index with azimuth and elevation stored to 0.01° for interactive threshold filtering.
- Satellites with a nonzero SEM health value or below the selected elevation mask are excluded.
- Almanac orbits are intentionally low precision and are appropriate for geometry/availability analysis, not precision positioning.
