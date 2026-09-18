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
  addAdjustment: document.querySelector("#add-adjustment"),
  applyAdjustments: document.querySelector("#apply-adjustments"),
  adjustmentDialog: document.querySelector("#adjustment-dialog"),
  adjustmentDialogTitle: document.querySelector("#adjustment-dialog-title"),
  adjustmentForm: document.querySelector("#adjustment-form"),
  adjustmentPrn: document.querySelector("#adjustment-prn"),
  adjustmentSeconds: document.querySelector("#adjustment-seconds"),
  cancelAdjustment: document.querySelector("#cancel-adjustment"),
  adjustmentList: document.querySelector("#adjustment-list"),
  toggleAdjustments: document.querySelector("#toggle-adjustments"),
  globalMapLayout: document.querySelector("#global-map-layout"),
  globalDetail: document.querySelector("#global-detail"),
  globalDetailLocation: document.querySelector("#global-detail-location"),
  globalDetailStatus: document.querySelector("#global-detail-status"),
  globalSpikeChart: document.querySelector("#global-spike-chart"),
  globalSkyChart: document.querySelector("#global-sky-chart"),
};

let location = null;
let almanacData = null;
let worker = null;
let currentResult = null;
let synchronizingPlots = false;
let polarRenderTimer = null;
let globalWorker = null;
let comparisonWorker = null;
let globalDetailWorker = null;
let globalGrid = null;
let baselineRequest = null;
let availableAdjustmentPrns = [];
const satelliteAdjustments = new Map();
let editingAdjustmentPrn = null;
let globalDetailResult = null;

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

function createGlobalMap() {
  const leafletMap = L.map("global-map", {
    worldCopyJump: true,
    preferCanvas: true,
    zoomSnap: 0.5,
  }).setView([15, 0], 1.5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 8,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(leafletMap);
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = () => {
    const container = L.DomUtil.create("div", "global-legend");
    container.innerHTML = '<strong>Maximum GDOP</strong><br><span id="global-resolution">H3 resolution 1</span><div class="global-legend-gradient"></div><div class="global-legend-labels"><span>1</span><span>5.5</span><span>10+</span></div>';
    return container;
  };
  legend.addTo(leafletMap);
  const choices = {
    baseline: L.layerGroup().addTo(leafletMap),
    adjusted: L.layerGroup(),
  };
  L.control.layers({
    "Real SEM almanac": choices.baseline,
    "Adjusted SEM almanac": choices.adjusted,
  }, null, { collapsed: false, position: "topright" }).addTo(leafletMap);
  const view = {
    map: leafletMap,
    renderer: L.canvas({ padding: 0.5 }),
    resolutionId: "global-resolution",
    layer: null,
    display: null,
    datasets: { baseline: null, adjusted: null },
    activeKey: "baseline",
    choices,
    renderGeneration: 0,
    renderTimer: null,
  };
  leafletMap.on("baselayerchange", ({ layer }) => {
    view.activeKey = layer === choices.adjusted ? "adjusted" : "baseline";
    view.display = view.datasets[view.activeKey];
    if (view.display) {
      scheduleGlobalMapRender(view);
      if (view.display.summary) elements.globalStatus.value = view.display.summary;
      if (globalDetailResult) processGlobalDetail(globalDetailResult.latitude, globalDetailResult.longitude);
    } else {
      if (view.layer) leafletMap.removeLayer(view.layer);
      view.layer = null;
      elements.globalStatus.value = "Process this almanac layer before viewing it.";
    }
  });
  return view;
}

const globalView = createGlobalMap();
let globalDetailMarker = null;

globalView.map.on("click", ({ latlng }) => {
  if (!baselineRequest || !globalView.display) return;
  const longitude = ((latlng.lng + 180) % 360 + 360) % 360 - 180;
  processGlobalDetail(latlng.lat, longitude);
});

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
  elements.calculate.disabled = !location || !almanacData || Boolean(worker) || Boolean(globalWorker) || Boolean(comparisonWorker) || Boolean(globalDetailWorker);
}

function updateGlobalButtons() {
  const disabled = !currentResult || Boolean(globalWorker) || Boolean(comparisonWorker) || Boolean(globalDetailWorker);
  elements.globalFirst.disabled = disabled;
  elements.globalLast.disabled = disabled;
  elements.addAdjustment.disabled =
    !baselineRequest || Boolean(globalWorker) || Boolean(comparisonWorker) || Boolean(globalDetailWorker);
  elements.applyAdjustments.disabled =
    !baselineRequest || satelliteAdjustments.size === 0 || Boolean(globalWorker) || Boolean(comparisonWorker) || Boolean(globalDetailWorker);
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

function cellBoundaryNearCenter(cell, centerLongitude, longitudeOffset = 0) {
  return window.h3.cellToBoundary(cell).map(([latitude, longitude]) => {
    let adjusted = longitude;
    while (adjusted - centerLongitude > 180) adjusted -= 360;
    while (adjusted - centerLongitude < -180) adjusted += 360;
    return [latitude, adjusted + longitudeOffset];
  });
}

function aggregateGlobalMap(data, rangeLabel) {
  const grid = prepareGlobalGrid();
  const levels = Array.from({ length: 4 }, () => new Map());
  for (let index = 0; index < grid.cells.length; index += 1) {
    const value = data.maximum[index];
    for (let resolution = 0; resolution <= 3; resolution += 1) {
      const cell = resolution === 3 ? grid.cells[index] : window.h3.cellToParent(grid.cells[index], resolution);
      const previous = levels[resolution].get(cell);
      if (!previous || (!Number.isFinite(previous.value) && Number.isFinite(value)) || value > previous.value) {
        levels[resolution].set(cell, { cell, sourceIndex: index, value });
      }
    }
  }
  return {
    data,
    rangeLabel,
    levels: levels.map((level) => Array.from(level.values()).map((entry) => {
      const [latitude, longitude] = window.h3.cellToLatLng(entry.cell);
      return { ...entry, latitude, longitude };
    })),
  };
}

function visibleWorldOffsets(view) {
  const bounds = view.map.getBounds();
  const first = Math.floor((bounds.getWest() + 180) / 360);
  const last = Math.floor((bounds.getEast() + 180 - 1e-7) / 360);
  return Array.from({ length: Math.max(1, last - first + 1) }, (_, index) => (first + index) * 360);
}

async function renderGlobalMap(view) {
  if (!view.display) return;
  const generation = ++view.renderGeneration;
  if (view.layer) view.map.removeLayer(view.layer);
  view.layer = L.layerGroup().addTo(view.map);
  const grid = prepareGlobalGrid();
  const resolution = Math.max(0, Math.min(3, Math.floor(view.map.getZoom())));
  const entries = view.display.levels[resolution];
  const worldOffsets = visibleWorldOffsets(view);
  const resolutionLabel = document.querySelector(`#${view.resolutionId}`);
  if (resolutionLabel) resolutionLabel.textContent = `H3 resolution ${resolution}`;

  let drawn = 0;
  const total = entries.length * worldOffsets.length;
  for (const longitudeOffset of worldOffsets) {
    for (let first = 0; first < entries.length; first += 500) {
      if (generation !== view.renderGeneration) return;
      const end = Math.min(entries.length, first + 500);
      for (let index = first; index < end; index += 1) {
        const entry = entries[index];
        const sourceIndex = entry.sourceIndex;
        const value = entry.value;
        const time = view.display.data.maximumStep[sourceIndex] >= 0
          ? new Date((view.display.data.startUnixSeconds + view.display.data.maximumStep[sourceIndex] * view.display.data.intervalSeconds) * 1000)
            .toISOString().slice(0, 16).replace("T", " ")
          : "No valid geometry";
        const sourceDescription = resolution === 3
          ? `Center ${grid.latitudes[sourceIndex].toFixed(3)}°, ${grid.longitudes[sourceIndex].toFixed(3)}°`
          : `Worst child center ${grid.latitudes[sourceIndex].toFixed(3)}°, ${grid.longitudes[sourceIndex].toFixed(3)}°`;
        const popup = Number.isFinite(value)
          ? `<strong>${entry.cell}</strong><br>${sourceDescription}<br>Maximum GDOP ${value.toFixed(3)}<br>${time} UTC<br>${view.display.data.visible[sourceIndex]} visible satellites`
          : `<strong>${entry.cell}</strong><br>No valid geometry`;
        const color = globalGdopColor(value);
        L.polygon(cellBoundaryNearCenter(entry.cell, entry.longitude, longitudeOffset), {
          renderer: view.renderer,
          stroke: false,
          fill: true,
          fillColor: color,
          fillOpacity: 0.74,
        }).bindPopup(popup).addTo(view.layer);
      }
      drawn += end - first;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }
}

async function drawGlobalMap(view, datasetKey, data, rangeLabel, progress, status) {
  const grid = prepareGlobalGrid();
  let worstIndex = -1;
  let worstValue = -Infinity;
  for (let index = 0; index < grid.cells.length; index += 1) {
    if (Number.isFinite(data.maximum[index]) && data.maximum[index] > worstValue) {
      worstValue = data.maximum[index];
      worstIndex = index;
    }
  }
  const dataset = aggregateGlobalMap(data, rangeLabel);
  dataset.worstValue = worstValue;
  dataset.worstIndex = worstIndex;
  view.datasets[datasetKey] = dataset;
  view.display = view.datasets[view.activeKey];
  await renderGlobalMap(view);
  progress.value = 1;
  if (worstIndex >= 0) {
    const worstTime = new Date(
      (data.startUnixSeconds + data.maximumStep[worstIndex] * data.intervalSeconds) * 1000,
    ).toISOString().slice(0, 16).replace("T", " ");
    status.value = `${rangeLabel}: worst sampled GDOP ${worstValue.toFixed(2)} near ${grid.latitudes[worstIndex].toFixed(2)}°, ${grid.longitudes[worstIndex].toFixed(2)}° at ${worstTime} UTC.`;
  } else {
    status.value = `${rangeLabel}: no cells had valid geometry.`;
  }
  dataset.summary = status.value;
}

function scheduleGlobalMapRender(view) {
  clearTimeout(view.renderTimer);
  view.renderTimer = setTimeout(() => renderGlobalMap(view), 75);
}

globalView.map.on("zoomend moveend", () => {
  if (globalView.display) scheduleGlobalMapRender(globalView);
});

function processGlobalRange(which) {
  if (!currentResult || globalWorker || comparisonWorker || globalDetailWorker) return;
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
  baselineRequest = null;
  satelliteAdjustments.clear();
  renderAdjustmentList();
  globalView.datasets = { baseline: null, adjusted: null };
  globalView.activeKey = "baseline";
  globalView.display = null;
  if (globalView.layer) globalView.map.removeLayer(globalView.layer);
  globalView.layer = null;
  globalView.map.removeLayer(globalView.choices.adjusted);
  globalView.choices.baseline.addTo(globalView.map);
  elements.globalDetail.hidden = true;
  globalDetailResult = null;
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
      updateButton();
      await drawGlobalMap(globalView, "baseline", data, rangeLabel, elements.globalProgress, elements.globalStatus);
      globalView.datasets.baseline.adjustments = [];
      baselineRequest = {
        startUnixSeconds,
        endUnixSeconds,
        intervalSeconds: currentResult.intervalSeconds,
        elevationMaskDegrees: currentResult.elevationMaskDegrees,
        rangeLabel,
      };
      availableAdjustmentPrns = adjustmentPrnsForRange(baselineRequest);
      populateAdjustmentPrns();
      updateGlobalButtons();
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
    adjustments: [],
  }, [latitudes.buffer, longitudes.buffer]);
}

function nearestAlmanacForTime(unixSeconds) {
  const almanacs = almanacData.almanacs;
  let low = 0;
  let high = almanacs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (almanacs[middle][0] < unixSeconds) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return almanacs[0];
  if (low === almanacs.length) return almanacs[almanacs.length - 1];
  return unixSeconds - almanacs[low - 1][0] <= almanacs[low][0] - unixSeconds
    ? almanacs[low - 1]
    : almanacs[low];
}

function adjustmentPrnsForRange(request) {
  const prns = new Set();
  const sampleCount = Math.floor(
    (request.endUnixSeconds - request.startUnixSeconds) / request.intervalSeconds,
  ) + 1;
  for (let step = 0; step < sampleCount; step += 1) {
    const almanac = nearestAlmanacForTime(request.startUnixSeconds + step * request.intervalSeconds);
    for (const [prn, health] of almanac[3]) if (health === 0) prns.add(prn);
  }
  return Array.from(prns).sort((a, b) => a - b);
}

function populateAdjustmentPrns() {
  elements.adjustmentPrn.replaceChildren(...availableAdjustmentPrns.map((prn) => {
    const option = document.createElement("option");
    option.value = String(prn);
    option.textContent = `PRN ${prn}`;
    return option;
  }));
}

function openAdjustmentDialog(prn = null) {
  editingAdjustmentPrn = prn;
  populateAdjustmentPrns();
  elements.adjustmentDialogTitle.textContent = prn === null ? "Add satellite adjustment" : `Edit PRN ${prn} adjustment`;
  elements.adjustmentPrn.value = String(prn ?? availableAdjustmentPrns[0] ?? "");
  elements.adjustmentSeconds.value = prn === null ? "0" : String(satelliteAdjustments.get(prn));
  elements.adjustmentDialog.showModal();
}

function renderAdjustmentList() {
  if (satelliteAdjustments.size === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No adjustments added.";
    elements.adjustmentList.replaceChildren(empty);
  } else {
    const rows = Array.from(satelliteAdjustments.entries())
      .sort(([first], [second]) => first - second)
      .map(([prn, seconds]) => {
        const row = document.createElement("div");
        row.className = "adjustment-row";
        const text = document.createElement("span");
        text.textContent = `PRN ${prn}: ${seconds > 0 ? "+" : ""}${seconds} s`;
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "secondary-button";
        edit.textContent = "Edit";
        edit.addEventListener("click", () => openAdjustmentDialog(prn));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary-button";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
          satelliteAdjustments.delete(prn);
          renderAdjustmentList();
          if (globalView.datasets.adjusted) {
            elements.globalStatus.value = "Adjustments changed. Apply them to refresh the adjusted layer.";
          }
        });
        row.append(text, edit, remove);
        return row;
      });
    elements.adjustmentList.replaceChildren(...rows);
  }
  updateGlobalButtons();
}

function processAdjustedGlobalMap() {
  if (!baselineRequest || globalWorker || comparisonWorker || globalDetailWorker || satelliteAdjustments.size === 0) return;
  const grid = prepareGlobalGrid();
  const adjustments = Array.from(satelliteAdjustments.entries());
  comparisonWorker = new Worker("global-gdop-worker.js");
  updateGlobalButtons();
  updateButton();
  elements.globalProgress.value = 0;
  elements.globalStatus.value = `Applying ${adjustments.length} satellite adjustment${adjustments.length === 1 ? "" : "s"}…`;
  comparisonWorker.onmessage = async ({ data }) => {
    if (data.type === "progress") {
      elements.globalProgress.value = data.fraction * 0.95;
      elements.globalStatus.value = data.message.replace("Global map", "Adjusted map");
      return;
    }
    if (data.type === "error") {
      elements.globalStatus.value = `Adjusted calculation failed: ${data.message}`;
      comparisonWorker.terminate();
      comparisonWorker = null;
      updateGlobalButtons();
      updateButton();
      return;
    }
    if (data.type === "result") {
      comparisonWorker.terminate();
      comparisonWorker = null;
      await drawGlobalMap(
        globalView,
        "adjusted",
        data,
        `${baselineRequest.rangeLabel}, adjusted`,
        elements.globalProgress,
        elements.globalStatus,
      );
      globalView.datasets.adjusted.adjustments = adjustments;
      const baselineWorst = globalView.datasets.baseline?.worstValue;
      const adjustedWorst = globalView.datasets.adjusted.worstValue;
      if (Number.isFinite(baselineWorst) && Number.isFinite(adjustedWorst)) {
        const difference = adjustedWorst - baselineWorst;
        elements.globalStatus.value += ` Global worst-case change: ${difference >= 0 ? "+" : ""}${difference.toFixed(2)} GDOP.`;
      }
      globalView.datasets.adjusted.summary = elements.globalStatus.value;
      globalView.map.removeLayer(globalView.choices.baseline);
      globalView.choices.adjusted.addTo(globalView.map);
      updateGlobalButtons();
      updateButton();
    }
  };
  comparisonWorker.onerror = ({ message }) => {
    elements.globalStatus.value = `Adjusted calculation failed: ${message}`;
    comparisonWorker?.terminate();
    comparisonWorker = null;
    updateGlobalButtons();
    updateButton();
  };
  const latitudes = grid.latitudes.slice();
  const longitudes = grid.longitudes.slice();
  comparisonWorker.postMessage({
    type: "calculate",
    almanacs: almanacData.almanacs,
    latitudes,
    longitudes,
    ...baselineRequest,
    adjustments,
  }, [latitudes.buffer, longitudes.buffer]);
}

let globalDetailPlotBound = false;

function drawGlobalDetailSky() {
  if (!globalDetailResult) return;
  const theta = [];
  const radius = [];
  const hover = [];
  let samples = 0;
  for (let sample = 0; sample < globalDetailResult.timeSeconds.length; sample += 1) {
    const time = globalDetailResult.timeSeconds[sample];
    if (time < globalDetailResult.viewStart || time > globalDetailResult.viewEnd) continue;
    samples += 1;
    const timestamp = new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ");
    for (
      let observation = globalDetailResult.satelliteOffsets[sample];
      observation < globalDetailResult.satelliteOffsets[sample + 1];
      observation += 1
    ) {
      const elevation = globalDetailResult.satelliteElevation[observation] / 100;
      theta.push(globalDetailResult.satelliteAzimuth[observation] / 100);
      radius.push(90 - elevation);
      hover.push([
        globalDetailResult.satellitePrn[observation],
        timestamp,
        globalDetailResult.gdop[sample],
        elevation,
      ]);
    }
  }
  Plotly.react(elements.globalSkyChart, [{
    theta,
    r: radius,
    customdata: hover,
    type: "scatterpolargl",
    mode: "markers",
    marker: { color: "#146c74", size: 4, opacity: 0.3 },
    hovertemplate: "PRN %{customdata[0]}<br>%{customdata[1]} UTC<br>GDOP %{customdata[2]:.3f}<br>Elevation %{customdata[3]:.1f}°<extra></extra>",
  }], {
    height: 560,
    margin: { l: 50, r: 50, t: 42, b: 38 },
    paper_bgcolor: "#fffdf8",
    showlegend: false,
    title: { text: `${theta.length.toLocaleString()} satellite positions from ${samples.toLocaleString()} samples`, font: { size: 13, color: "#607078" } },
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
  }, { responsive: true, displaylogo: false });
}

function drawGlobalDetail(data, latitude, longitude, layerName) {
  const times = Array.from(data.times, (seconds) => new Date(seconds * 1000));
  const gdop = Array.from(data.gdop, (value) => (Number.isFinite(value) ? value : null));
  globalDetailResult = {
    latitude,
    longitude,
    layerName,
    timeSeconds: data.times,
    gdop,
    satelliteOffsets: data.satelliteOffsets,
    satelliteAzimuth: data.satelliteAzimuth,
    satelliteElevation: data.satelliteElevation,
    satellitePrn: data.satellitePrn,
    viewStart: data.times[0],
    viewEnd: data.times[data.times.length - 1],
  };
  Plotly.react(elements.globalSpikeChart, [{
    x: times.map(plotUtcValue),
    y: gdop,
    customdata: Array.from(data.visible),
    type: "scattergl",
    mode: "lines",
    line: { color: "#9d3f2c", width: 1.4 },
    hovertemplate: "%{x|%Y-%m-%d %H:%M} UTC<br>GDOP %{y:.3f}<br>%{customdata} satellites<extra></extra>",
    connectgaps: false,
  }], {
    height: 400,
    margin: { l: 58, r: 24, t: 32, b: 58 },
    paper_bgcolor: "#fffdf8",
    plot_bgcolor: "#fffdf8",
    title: { text: `${layerName} — GDOP over time`, font: { size: 14 } },
    xaxis: { title: "UTC time", gridcolor: "#e4e0d7" },
    yaxis: { title: "GDOP", rangemode: "tozero", gridcolor: "#e4e0d7" },
  }, { responsive: true, displaylogo: false }).then(() => {
    if (globalDetailPlotBound) return;
    globalDetailPlotBound = true;
    elements.globalSpikeChart.on("plotly_relayout", (event) => {
      if (!globalDetailResult) return;
      if (event["xaxis.autorange"]) {
        globalDetailResult.viewStart = globalDetailResult.timeSeconds[0];
        globalDetailResult.viewEnd = globalDetailResult.timeSeconds[globalDetailResult.timeSeconds.length - 1];
      } else {
        const range = rangeFromRelayout(event, "xaxis");
        if (!range) return;
        const bounds = range.map(parsePlotUtcValue).sort((a, b) => a - b);
        if (!bounds.every(Number.isFinite)) return;
        globalDetailResult.viewStart = Math.max(globalDetailResult.timeSeconds[0], bounds[0]);
        globalDetailResult.viewEnd = Math.min(
          globalDetailResult.timeSeconds[globalDetailResult.timeSeconds.length - 1],
          bounds[1],
        );
      }
      drawGlobalDetailSky();
    });
  });
  drawGlobalDetailSky();
  elements.globalDetailStatus.textContent = `${layerName} · ${gdop.filter((value) => value !== null).length.toLocaleString()} valid samples`;
}

function processGlobalDetail(latitude, longitude) {
  const dataset = globalView.datasets[globalView.activeKey];
  if (!baselineRequest || !dataset) return;
  globalDetailWorker?.terminate();
  globalDetailWorker = new Worker("gdop-worker.js");
  elements.globalDetail.hidden = false;
  elements.globalDetailLocation.textContent = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
  elements.globalDetailStatus.textContent = "Calculating selected location…";
  if (!globalDetailMarker) globalDetailMarker = L.marker([latitude, longitude]).addTo(globalView.map);
  else globalDetailMarker.setLatLng([latitude, longitude]);
  const layerName = globalView.activeKey === "adjusted" ? "Adjusted SEM almanac" : "Real SEM almanac";
  globalDetailWorker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      elements.globalDetailStatus.textContent = data.message;
      return;
    }
    if (data.type === "result") {
      globalDetailWorker.terminate();
      globalDetailWorker = null;
      drawGlobalDetail(data, latitude, longitude, layerName);
      updateGlobalButtons();
      updateButton();
    }
  };
  globalDetailWorker.onerror = ({ message }) => {
    elements.globalDetailStatus.textContent = `Selected-location calculation failed: ${message}`;
    globalDetailWorker?.terminate();
    globalDetailWorker = null;
    updateGlobalButtons();
    updateButton();
  };
  updateGlobalButtons();
  updateButton();
  globalDetailWorker.postMessage({
    type: "calculate",
    almanacs: almanacData.almanacs,
    latitudeDegrees: latitude,
    longitudeDegrees: longitude,
    startUnixSeconds: baselineRequest.startUnixSeconds,
    endUnixSeconds: baselineRequest.endUnixSeconds,
    intervalSeconds: baselineRequest.intervalSeconds,
    elevationMaskDegrees: baselineRequest.elevationMaskDegrees,
    adjustments: dataset.adjustments || [],
  });
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
elements.addAdjustment.addEventListener("click", () => openAdjustmentDialog());
elements.cancelAdjustment.addEventListener("click", () => elements.adjustmentDialog.close());
elements.adjustmentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const prn = Number(elements.adjustmentPrn.value);
  const seconds = Number(elements.adjustmentSeconds.value);
  if (!availableAdjustmentPrns.includes(prn) || !Number.isFinite(seconds) || seconds === 0) {
    elements.adjustmentSeconds.setCustomValidity("Enter a nonzero number of seconds.");
    elements.adjustmentSeconds.reportValidity();
    return;
  }
  elements.adjustmentSeconds.setCustomValidity("");
  if (editingAdjustmentPrn !== null && editingAdjustmentPrn !== prn) {
    satelliteAdjustments.delete(editingAdjustmentPrn);
  }
  satelliteAdjustments.set(prn, seconds);
  editingAdjustmentPrn = null;
  elements.adjustmentDialog.close();
  renderAdjustmentList();
  if (globalView.datasets.adjusted) {
    elements.globalStatus.value = "Adjustments changed. Apply them to refresh the adjusted layer.";
  }
});
elements.adjustmentSeconds.addEventListener("input", () => {
  elements.adjustmentSeconds.setCustomValidity("");
});
elements.applyAdjustments.addEventListener("click", processAdjustedGlobalMap);
elements.toggleAdjustments.addEventListener("click", () => {
  const collapsed = elements.globalMapLayout.classList.toggle("sidebar-collapsed");
  elements.toggleAdjustments.textContent = collapsed ? "Show adjustments" : "Hide adjustments";
  elements.toggleAdjustments.setAttribute("aria-expanded", String(!collapsed));
  setTimeout(() => globalView.map.invalidateSize(), 200);
});
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
  baselineRequest = null;
  availableAdjustmentPrns = [];
  satelliteAdjustments.clear();
  renderAdjustmentList();
  globalView.datasets = { baseline: null, adjusted: null };
  globalView.activeKey = "baseline";
  globalView.display = null;
  if (globalView.layer) globalView.map.removeLayer(globalView.layer);
  globalView.layer = null;
  globalView.map.removeLayer(globalView.choices.adjusted);
  globalView.choices.baseline.addTo(globalView.map);
  elements.globalDetail.hidden = true;
  globalDetailResult = null;
  if (globalDetailMarker) {
    globalView.map.removeLayer(globalDetailMarker);
    globalDetailMarker = null;
  }
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
