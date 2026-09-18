const DATA_URL = "data/almanacs.json";

const elements = {
  coordinates: document.querySelector("#coordinates"),
  dataSummary: document.querySelector("#data-summary"),
  form: document.querySelector("#controls"),
  start: document.querySelector("#start-time"),
  end: document.querySelector("#end-time"),
  interval: document.querySelector("#interval"),
  elevationMask: document.querySelector("#elevation-mask"),
  calculate: document.querySelector("#calculate"),
  progress: document.querySelector("#progress"),
  status: document.querySelector("#status"),
  resultSummary: document.querySelector("#result-summary"),
  threshold: document.querySelector("#gdop-threshold"),
  resetPolar: document.querySelector("#reset-polar"),
  chart: document.querySelector("#chart"),
  heatmap: document.querySelector("#heatmap"),
  polarChart: document.querySelector("#polar-chart"),
  globalFirst: document.querySelector("#global-first"),
  globalLast: document.querySelector("#global-last"),
  globalProgress: document.querySelector("#global-progress"),
  globalStatus: document.querySelector("#global-status"),
  globalMap: document.querySelector("#global-map"),
};

let location = null;
let almanacData = null;
let worker = null;
let currentResult = null;
let synchronizingPlots = false;
let polarRenderTimer = null;
let globalWorker = null;
let globalGrid = null;
let globalLayer = null;

const map = L.map("map", { worldCopyJump: true }).setView([25, 0], 2);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const markerIcon = L.divIcon({
  className: "",
  html: '<div class="location-marker"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
let marker = null;

const globalMap = L.map("global-map", {
  worldCopyJump: true,
  preferCanvas: true,
  zoomSnap: 0.5,
}).setView([15, 0], 1.5);
const globalRenderer = L.canvas({ padding: 0.5 });
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 8,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(globalMap);

const globalLegend = L.control({ position: "bottomright" });
globalLegend.onAdd = () => {
  const container = L.DomUtil.create("div", "global-legend");
  container.innerHTML = '<strong>Maximum GDOP</strong><div class="global-legend-gradient"></div><div class="global-legend-labels"><span>1</span><span>5.5</span><span>10+</span></div>';
  return container;
};
globalLegend.addTo(globalMap);

map.on("click", ({ latlng }) => {
  location = { latitude: latlng.lat, longitude: latlng.lng };
  if (!marker) marker = L.marker(latlng, { icon: markerIcon }).addTo(map);
  else marker.setLatLng(latlng);
  elements.coordinates.value = `${latlng.lat.toFixed(5)}°, ${latlng.lng.toFixed(5)}°`;
  elements.status.value = "Ready to calculate.";
  updateButton();
});

function utcInputValue(date) {
  return date.toISOString().slice(0, 16);
}

const defaultEnd = new Date();
defaultEnd.setUTCSeconds(0, 0);
const defaultStart = new Date(defaultEnd.getTime() - 7 * 86_400_000);
elements.start.value = utcInputValue(defaultStart);
elements.end.value = utcInputValue(defaultEnd);

function updateButton() {
  elements.calculate.disabled = !location || !almanacData || Boolean(worker) || Boolean(globalWorker);
}

function updateGlobalButtons() {
  const disabled = !currentResult || Boolean(globalWorker);
  elements.globalFirst.disabled = disabled;
  elements.globalLast.disabled = disabled;
}

function parseUtcInput(input) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return Number.isFinite(milliseconds) ? milliseconds / 1000 : NaN;
}

// Plotly date axes can format Date objects in the browser's local timezone.
// Supplying the UTC clock fields without a timezone keeps the displayed axis
// identical on computers in every timezone while calculations retain Unix time.
function plotUtcValue(date) {
  return date.toISOString().slice(0, 23);
}

function parsePlotUtcValue(value) {
  if (value instanceof Date) return value.getTime() / 1000;
  const text = String(value).trim().replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const milliseconds = Date.parse(hasTimezone ? text : `${text}Z`);
  return milliseconds / 1000;
}

async function loadData() {
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    almanacData = await response.json();
    elements.dataSummary.textContent = `${almanacData.almanacs.length} snapshots · ${almanacData.years.join("–")}`;
    elements.status.value = "Select a location to begin.";
    updateButton();
  } catch (error) {
    elements.dataSummary.textContent = "Data unavailable";
    elements.status.value = `Could not load ${DATA_URL}: ${error.message}. Serve this folder over HTTP.`;
  }
}

function drawEmptyChart() {
  const linePlot = Plotly.newPlot(
    "chart",
    [{ x: [], y: [], type: "scattergl", mode: "lines", line: { color: "#146c74", width: 1.5 } }],
    {
      margin: { l: 58, r: 24, t: 20, b: 58 },
      paper_bgcolor: "#fffdf8",
      plot_bgcolor: "#fffdf8",
      xaxis: { title: "UTC time", gridcolor: "#e4e0d7" },
      yaxis: { title: "GDOP", rangemode: "tozero", gridcolor: "#e4e0d7" },
      annotations: [{ text: "Results will appear here", showarrow: false, font: { color: "#607078" } }],
    },
    { responsive: true, displaylogo: false },
  );

  const heatmapPlot = Plotly.newPlot(
    "heatmap",
    [{ z: [[null]], type: "heatmap", showscale: false, hoverinfo: "skip" }],
    {
      height: 320,
      margin: { l: 88, r: 24, t: 20, b: 58 },
      paper_bgcolor: "#fffdf8",
      plot_bgcolor: "#fffdf8",
      xaxis: { title: "UTC time of day", visible: false },
      yaxis: { title: "UTC day", visible: false },
      annotations: [{ text: "Results will appear here", showarrow: false, font: { color: "#607078" } }],
    },
    { responsive: true, displaylogo: false },
  );

  const polarPlot = Plotly.newPlot(
    "polar-chart",
    [{
      theta: [],
      r: [],
      customdata: [],
      type: "scatterpolargl",
      mode: "markers",
      marker: { color: "#146c74", size: 4, opacity: 0.28 },
      hovertemplate: "PRN %{customdata[0]}<br>%{customdata[1]} UTC<br>GDOP %{customdata[2]:.3f}<br>Azimuth %{customdata[3]:.1f}°<br>Elevation %{customdata[4]:.1f}°<extra></extra>",
    }],
    {
      height: 620,
      margin: { l: 50, r: 50, t: 38, b: 38 },
      paper_bgcolor: "#fffdf8",
      showlegend: false,
      polar: {
        bgcolor: "#fffdf8",
        angularaxis: {
          direction: "clockwise",
          rotation: 90,
          tickmode: "array",
          tickvals: [0, 45, 90, 135, 180, 225, 270, 315],
          ticktext: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
          gridcolor: "#d9d4c8",
        },
        radialaxis: {
          range: [0, 90],
          tickvals: [0, 30, 60, 90],
          ticktext: ["90°", "60°", "30°", "0°"],
          gridcolor: "#d9d4c8",
          angle: 90,
        },
      },
      annotations: [{ text: "Calculate GDOP to populate the sky view", showarrow: false, font: { color: "#607078" } }],
    },
    { responsive: true, displaylogo: false },
  );

  Promise.all([linePlot, heatmapPlot, polarPlot]).then(bindPlotSynchronization);
}

function drawHeatmap(times, gdop, intervalSeconds, limits) {
  const dayIndexes = new Map();
  const days = [];
  const columnCount = Math.ceil(86_400 / intervalSeconds);

  for (const time of times) {
    const day = time.toISOString().slice(0, 10);
    if (!dayIndexes.has(day)) {
      dayIndexes.set(day, days.length);
      days.push(day);
    }
  }

  const values = Array.from({ length: days.length }, () => Array(columnCount).fill(null));
  for (let index = 0; index < times.length; index += 1) {
    if (gdop[index] === null) continue;
    const time = times[index];
    const secondsOfDay = time.getUTCHours() * 3600 + time.getUTCMinutes() * 60 + time.getUTCSeconds();
    const column = Math.min(columnCount - 1, Math.floor(secondsOfDay / intervalSeconds));
    values[dayIndexes.get(time.toISOString().slice(0, 10))][column] = gdop[index];
  }

  const columnLabels = Array.from({ length: columnCount }, (_, index) => {
    const seconds = index * intervalSeconds;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  });
  const height = Math.max(320, Math.min(900, 150 + days.length * 18));

  Plotly.react(
    "heatmap",
    [{
      x: columnLabels,
      y: days,
      z: values,
      type: "heatmap",
      colorscale: [[0, "#159947"], [0.5, "#f1d447"], [1, "#d64032"]],
      zmin: limits[0],
      zmax: limits[1],
      xgap: 0,
      ygap: 0,
      colorbar: { title: { text: "GDOP" }, thickness: 14 },
      hoverongaps: false,
      hovertemplate: "%{y}<br>%{x} UTC<br>GDOP %{z:.3f}<extra></extra>",
    }],
    {
      height,
      margin: { l: 88, r: 76, t: 20, b: 58 },
      paper_bgcolor: "#fffdf8",
      plot_bgcolor: "#fffdf8",
      xaxis: {
        title: "UTC time of day",
        type: "category",
        tickmode: "array",
        tickvals: columnLabels.filter((_, index) => index % Math.max(1, Math.round(3600 / intervalSeconds) * 3) === 0),
        gridcolor: "rgba(0,0,0,0)",
      },
      yaxis: {
        title: "UTC day",
        type: "category",
        autorange: "reversed",
        gridcolor: "rgba(0,0,0,0)",
      },
    },
    { responsive: true, displaylogo: false },
  );
  return { days, columnLabels };
}

function schedulePolarRender() {
  clearTimeout(polarRenderTimer);
  polarRenderTimer = setTimeout(drawPolarPlot, 100);
}

function drawPolarPlot() {
  if (!currentResult) return;
  const threshold = Number(elements.threshold.value);
  if (!Number.isFinite(threshold)) return;

  const theta = [];
  const radius = [];
  const hover = [];
  let qualifyingSamples = 0;

  for (let sample = 0; sample < currentResult.timeSeconds.length; sample += 1) {
    const unixSeconds = currentResult.timeSeconds[sample];
    const value = currentResult.gdop[sample];
    if (
      value === null ||
      value <= threshold ||
      unixSeconds < currentResult.viewStart ||
      unixSeconds > currentResult.viewEnd
    ) continue;

    const secondsOfDay = ((unixSeconds % 86_400) + 86_400) % 86_400;
    if (secondsOfDay < currentResult.timeOfDayStart || secondsOfDay >= currentResult.timeOfDayEnd) continue;
    qualifyingSamples += 1;

    const timestamp = new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace("T", " ");
    for (
      let observation = currentResult.satelliteOffsets[sample];
      observation < currentResult.satelliteOffsets[sample + 1];
      observation += 1
    ) {
      theta.push(currentResult.satelliteAzimuth[observation] / 100);
      radius.push(90 - currentResult.satelliteElevation[observation] / 100);
      hover.push([
        currentResult.satellitePrn[observation],
        timestamp,
        value,
        currentResult.satelliteAzimuth[observation] / 100,
        currentResult.satelliteElevation[observation] / 100,
      ]);
    }
  }

  const annotations = theta.length ? [] : [{
    text: `No samples above GDOP ${threshold.toFixed(2)} in this view`,
    showarrow: false,
    font: { color: "#607078" },
  }];
  const title = `${theta.length.toLocaleString()} satellite positions from ${qualifyingSamples.toLocaleString()} samples`;
  Promise.all([
    Plotly.restyle(elements.polarChart, {
      theta: [theta],
      r: [radius],
      customdata: [hover],
      marker: [{ color: "#146c74", size: 4, opacity: 0.28 }],
      hovertemplate: ["PRN %{customdata[0]}<br>%{customdata[1]} UTC<br>GDOP %{customdata[2]:.3f}<br>Azimuth %{customdata[3]:.1f}°<br>Elevation %{customdata[4]:.1f}°<extra></extra>"],
    }, [0]),
    Plotly.relayout(elements.polarChart, {
      "title.text": title,
      "title.font.size": 13,
      "title.font.color": "#607078",
      annotations,
    }),
  ]).catch((error) => {
    elements.status.value = `Could not update the sky view: ${error.message}`;
  });
}

function prepareGlobalGrid() {
  if (globalGrid) return globalGrid;
  if (!window.h3) throw new Error("The H3 library did not load");
  const cells = window.h3.getRes0Cells().flatMap((cell) => window.h3.cellToChildren(cell, 3));
  const latitudes = new Float64Array(cells.length);
  const longitudes = new Float64Array(cells.length);
  cells.forEach((cell, index) => {
    [latitudes[index], longitudes[index]] = window.h3.cellToLatLng(cell);
  });
  globalGrid = { cells, latitudes, longitudes };
  return globalGrid;
}

function globalGdopColor(value) {
  if (!Number.isFinite(value)) return "#3d4650";
  const position = Math.max(0, Math.min(1, (value - 1) / 9));
  const stops = position <= 0.5
    ? [[21, 153, 71], [241, 212, 71], position * 2]
    : [[241, 212, 71], [214, 64, 50], (position - 0.5) * 2];
  const [start, end, fraction] = stops;
  const channel = (index) => Math.round(start[index] + (end[index] - start[index]) * fraction);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function cellBoundaryNearCenter(cell, centerLongitude) {
  return window.h3.cellToBoundary(cell).map(([latitude, longitude]) => {
    let adjusted = longitude;
    while (adjusted - centerLongitude > 180) adjusted -= 360;
    while (adjusted - centerLongitude < -180) adjusted += 360;
    return [latitude, adjusted];
  });
}

async function drawGlobalMap(data, rangeLabel) {
  if (globalLayer) globalMap.removeLayer(globalLayer);
  globalLayer = L.layerGroup().addTo(globalMap);
  const grid = prepareGlobalGrid();
  let worstIndex = -1;
  let worstValue = -Infinity;

  for (let first = 0; first < grid.cells.length; first += 500) {
    const end = Math.min(grid.cells.length, first + 500);
    for (let index = first; index < end; index += 1) {
      const value = data.maximum[index];
      if (Number.isFinite(value) && value > worstValue) {
        worstValue = value;
        worstIndex = index;
      }
      const time = data.maximumStep[index] >= 0
        ? new Date((data.startUnixSeconds + data.maximumStep[index] * data.intervalSeconds) * 1000)
          .toISOString().slice(0, 16).replace("T", " ")
        : "No valid geometry";
      const popup = Number.isFinite(value)
        ? `<strong>${grid.cells[index]}</strong><br>Center ${grid.latitudes[index].toFixed(3)}°, ${grid.longitudes[index].toFixed(3)}°<br>Maximum GDOP ${value.toFixed(3)}<br>${time} UTC<br>${data.visible[index]} visible satellites`
        : `<strong>${grid.cells[index]}</strong><br>No valid geometry`;
      L.polygon(cellBoundaryNearCenter(grid.cells[index], grid.longitudes[index]), {
        renderer: globalRenderer,
        stroke: false,
        fill: true,
        fillColor: globalGdopColor(value),
        fillOpacity: 0.74,
      }).bindPopup(popup).addTo(globalLayer);
    }
    elements.globalProgress.value = 0.95 + 0.05 * end / grid.cells.length;
    elements.globalStatus.value = `Drawing ${end.toLocaleString()} of ${grid.cells.length.toLocaleString()} H3 cells…`;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  elements.globalProgress.value = 1;
  if (worstIndex >= 0) {
    const worstTime = new Date(
      (data.startUnixSeconds + data.maximumStep[worstIndex] * data.intervalSeconds) * 1000,
    ).toISOString().slice(0, 16).replace("T", " ");
    elements.globalStatus.value = `${rangeLabel}: worst sampled GDOP ${worstValue.toFixed(2)} near ${grid.latitudes[worstIndex].toFixed(2)}°, ${grid.longitudes[worstIndex].toFixed(2)}° at ${worstTime} UTC.`;
  } else {
    elements.globalStatus.value = `${rangeLabel}: no cells had valid geometry.`;
  }
}

function processGlobalRange(which) {
  if (!currentResult || globalWorker) return;
  let grid;
  try {
    grid = prepareGlobalGrid();
  } catch (error) {
    elements.globalStatus.value = error.message;
    return;
  }

  const daySeconds = 86_400;
  const startUnixSeconds = which === "first"
    ? currentResult.fullStart
    : Math.max(currentResult.fullStart, currentResult.fullEnd - daySeconds);
  const endUnixSeconds = which === "first"
    ? Math.min(currentResult.fullEnd, currentResult.fullStart + daySeconds)
    : currentResult.fullEnd;
  const rangeLabel = which === "first" ? "First 24 hours" : "Last 24 hours";
  globalWorker = new Worker("global-gdop-worker.js");
  updateGlobalButtons();
  updateButton();
  elements.globalProgress.value = 0;
  elements.globalStatus.value = `Preparing ${grid.cells.length.toLocaleString()} H3 cells…`;

  globalWorker.onmessage = async ({ data }) => {
    if (data.type === "progress") {
      elements.globalProgress.value = data.fraction * 0.95;
      elements.globalStatus.value = data.message;
      return;
    }
    if (data.type === "error") {
      elements.globalStatus.value = `Global calculation failed: ${data.message}`;
      globalWorker.terminate();
      globalWorker = null;
      updateGlobalButtons();
      updateButton();
      return;
    }
    if (data.type === "result") {
      globalWorker.terminate();
      globalWorker = null;
      updateGlobalButtons();
      updateButton();
      await drawGlobalMap(data, rangeLabel);
    }
  };
  globalWorker.onerror = ({ message }) => {
    elements.globalStatus.value = `Global calculation failed: ${message}`;
    globalWorker?.terminate();
    globalWorker = null;
    updateGlobalButtons();
    updateButton();
  };
  const latitudes = grid.latitudes.slice();
  const longitudes = grid.longitudes.slice();
  globalWorker.postMessage({
    type: "calculate",
    almanacs: almanacData.almanacs,
    latitudes,
    longitudes,
    startUnixSeconds,
    endUnixSeconds,
    intervalSeconds: currentResult.intervalSeconds,
    elevationMaskDegrees: currentResult.elevationMaskDegrees,
  }, [latitudes.buffer, longitudes.buffer]);
}

function rangeFromRelayout(event, axis) {
  if (Array.isArray(event[`${axis}.range`])) return event[`${axis}.range`];
  const start = event[`${axis}.range[0]`];
  const end = event[`${axis}.range[1]`];
  return start === undefined || end === undefined ? null : [start, end];
}

function syncHeatmapDaysToLine() {
  if (!currentResult) return;
  const firstDay = new Date(currentResult.viewStart * 1000).toISOString().slice(0, 10);
  const lastDay = new Date(currentResult.viewEnd * 1000).toISOString().slice(0, 10);
  const firstIndex = Math.max(0, currentResult.days.indexOf(firstDay));
  const foundLast = currentResult.days.indexOf(lastDay);
  const lastIndex = foundLast < 0 ? currentResult.days.length - 1 : foundLast;
  synchronizingPlots = true;
  Plotly.relayout("heatmap", { "yaxis.range": [lastIndex + 0.5, firstIndex - 0.5] })
    .finally(() => { synchronizingPlots = false; });
}

function syncLineToHeatmapDays(firstIndex, lastIndex) {
  if (!currentResult) return;
  const dayStart = Date.parse(`${currentResult.days[firstIndex]}T00:00:00Z`) / 1000;
  const dayEnd = Date.parse(`${currentResult.days[lastIndex]}T23:59:59.999Z`) / 1000;
  currentResult.viewStart = Math.max(currentResult.fullStart, dayStart);
  currentResult.viewEnd = Math.min(currentResult.fullEnd, dayEnd);
  synchronizingPlots = true;
  Plotly.relayout("chart", {
    "xaxis.range": [
      plotUtcValue(new Date(currentResult.viewStart * 1000)),
      plotUtcValue(new Date(currentResult.viewEnd * 1000)),
    ],
  }).finally(() => { synchronizingPlots = false; });
}

function heatmapCategoryIndex(value, categories) {
  if (typeof value === "number") return value;
  const index = categories.indexOf(String(value));
  return index < 0 ? NaN : index;
}

function bindPlotSynchronization() {
  elements.chart.on("plotly_relayout", (event) => {
    if (synchronizingPlots || !currentResult) return;
    if (event["xaxis.autorange"]) {
      currentResult.viewStart = currentResult.fullStart;
      currentResult.viewEnd = currentResult.fullEnd;
      synchronizingPlots = true;
      Plotly.relayout("heatmap", { "yaxis.autorange": "reversed" })
        .finally(() => { synchronizingPlots = false; });
      schedulePolarRender();
      return;
    }
    const range = rangeFromRelayout(event, "xaxis");
    if (!range) return;
    const bounds = range.map(parsePlotUtcValue).sort((a, b) => a - b);
    if (!bounds.every(Number.isFinite)) return;
    currentResult.viewStart = Math.max(currentResult.fullStart, bounds[0]);
    currentResult.viewEnd = Math.min(currentResult.fullEnd, bounds[1]);
    syncHeatmapDaysToLine();
    schedulePolarRender();
  });

  elements.heatmap.on("plotly_relayout", (event) => {
    if (synchronizingPlots || !currentResult) return;
    let changed = false;

    if (event["yaxis.autorange"]) {
      currentResult.viewStart = currentResult.fullStart;
      currentResult.viewEnd = currentResult.fullEnd;
      synchronizingPlots = true;
      Plotly.relayout("chart", { "xaxis.autorange": true })
        .finally(() => { synchronizingPlots = false; });
      changed = true;
    } else {
      const yRange = rangeFromRelayout(event, "yaxis");
      if (yRange) {
        const categoryBounds = yRange
          .map((value) => heatmapCategoryIndex(value, currentResult.days))
          .sort((a, b) => a - b);
        if (categoryBounds.every(Number.isFinite)) {
          const first = Math.max(0, Math.ceil(categoryBounds[0]));
          const last = Math.min(currentResult.days.length - 1, Math.floor(categoryBounds[1]));
          if (first <= last) syncLineToHeatmapDays(first, last);
          changed = true;
        }
      }
    }

    if (event["xaxis.autorange"]) {
      currentResult.timeOfDayStart = 0;
      currentResult.timeOfDayEnd = 86_400;
      changed = true;
    } else {
      const xRange = rangeFromRelayout(event, "xaxis");
      if (xRange) {
        const categoryBounds = xRange
          .map((value) => heatmapCategoryIndex(value, currentResult.columnLabels))
          .sort((a, b) => a - b);
        if (categoryBounds.every(Number.isFinite)) {
          const first = Math.max(0, Math.ceil(categoryBounds[0]));
          const last = Math.min(currentResult.columnLabels.length - 1, Math.floor(categoryBounds[1]));
          currentResult.timeOfDayStart = first * currentResult.intervalSeconds;
          currentResult.timeOfDayEnd = Math.min(86_400, (last + 1) * currentResult.intervalSeconds);
          changed = true;
        }
      }
    }
    if (changed) schedulePolarRender();
  });
}

elements.threshold.addEventListener("input", schedulePolarRender);
elements.threshold.addEventListener("change", schedulePolarRender);
elements.globalFirst.addEventListener("click", () => processGlobalRange("first"));
elements.globalLast.addEventListener("click", () => processGlobalRange("last"));
elements.resetPolar.addEventListener("click", () => {
  Plotly.relayout("polar-chart", {
    "polar.radialaxis.range": [0, 90],
    "polar.angularaxis.rotation": 90,
  });
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const startUnixSeconds = parseUtcInput(elements.start);
  const endUnixSeconds = parseUtcInput(elements.end);
  const intervalSeconds = Number(elements.interval.value) * 60;
  const elevationMaskDegrees = Number(elements.elevationMask.value);

  if (!Number.isFinite(startUnixSeconds) || !Number.isFinite(endUnixSeconds)) {
    elements.status.value = "Enter valid UTC start and end times.";
    return;
  }
  if (endUnixSeconds < startUnixSeconds) {
    elements.status.value = "The end time must not precede the start time.";
    return;
  }

  const sampleCount = Math.floor((endUnixSeconds - startUnixSeconds) / intervalSeconds) + 1;
  if (sampleCount > 525_601) {
    elements.status.value = "That range contains more than 525,601 samples. Increase the interval.";
    return;
  }

  worker = new Worker("gdop-worker.js");
  elements.progress.value = 0;
  elements.status.value = `Preparing ${sampleCount.toLocaleString()} samples…`;
  elements.resultSummary.textContent = "";
  elements.threshold.disabled = true;
  currentResult = null;
  updateGlobalButtons();
  updateButton();

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      elements.progress.value = data.fraction;
      elements.status.value = data.message;
      return;
    }
    if (data.type === "result") {
      const times = Array.from(data.times, (seconds) => new Date(seconds * 1000));
      const plotTimes = times.map(plotUtcValue);
      const gdop = Array.from(data.gdop, (value) => (Number.isFinite(value) ? value : null));
      const visible = Array.from(data.visible);
      const valid = gdop.filter((value) => value !== null);
      const limits = valid.reduce(
        (range, value) => [Math.min(range[0], value), Math.max(range[1], value)],
        [Infinity, -Infinity],
      );

      Plotly.react(
        "chart",
        [{
          x: plotTimes,
          y: gdop,
          customdata: visible,
          type: "scattergl",
          mode: "lines",
          line: { color: "#146c74", width: 1.4 },
          hovertemplate: "%{x|%Y-%m-%d %H:%M} UTC<br>GDOP %{y:.3f}<br>%{customdata} satellites<extra></extra>",
          connectgaps: false,
        }],
        {
          margin: { l: 58, r: 24, t: 20, b: 58 },
          paper_bgcolor: "#fffdf8",
          plot_bgcolor: "#fffdf8",
          hovermode: "x unified",
          xaxis: { title: "UTC time", gridcolor: "#e4e0d7" },
          yaxis: { title: "GDOP", rangemode: "tozero", gridcolor: "#e4e0d7" },
        },
        { responsive: true, displaylogo: false },
      );

      if (valid.length) {
        synchronizingPlots = true;
        const heatmapMetadata = drawHeatmap(times, gdop, intervalSeconds, limits);
        currentResult = {
          timeSeconds: data.times,
          times,
          gdop,
          satelliteOffsets: data.satelliteOffsets,
          satelliteAzimuth: data.satelliteAzimuth,
          satelliteElevation: data.satelliteElevation,
          satellitePrn: data.satellitePrn,
          intervalSeconds,
          elevationMaskDegrees,
          days: heatmapMetadata.days,
          columnLabels: heatmapMetadata.columnLabels,
          fullStart: data.times[0],
          fullEnd: data.times[data.times.length - 1],
          viewStart: data.times[0],
          viewEnd: data.times[data.times.length - 1],
          timeOfDayStart: 0,
          timeOfDayEnd: 86_400,
        };
        elements.threshold.disabled = false;
        elements.globalStatus.value = "Choose the first or last 24 hours to build the global map.";
        updateGlobalButtons();
        Promise.resolve().then(() => {
          synchronizingPlots = false;
          drawPolarPlot();
        });
      }

      const missing = gdop.length - valid.length;
      elements.resultSummary.textContent = valid.length
        ? `${valid.length.toLocaleString()} valid · GDOP ${limits[0].toFixed(2)}–${limits[1].toFixed(2)}`
        : "No valid geometry";
      elements.status.value = missing
        ? `Complete. ${missing.toLocaleString()} samples had fewer than four visible satellites or singular geometry.`
        : "Complete.";
      elements.progress.value = 1;
      worker.terminate();
      worker = null;
      updateButton();
    }
  };

  worker.onerror = ({ message }) => {
    elements.status.value = `Calculation failed: ${message}`;
    worker?.terminate();
    worker = null;
    updateButton();
  };

  worker.postMessage({
    type: "calculate",
    almanacs: almanacData.almanacs,
    latitudeDegrees: location.latitude,
    longitudeDegrees: location.longitude,
    startUnixSeconds,
    endUnixSeconds,
    intervalSeconds,
    elevationMaskDegrees,
  });
});

drawEmptyChart();
loadData();
