const GPS_MU = 3.986005e14;
const NOMINAL_GPS_SEMI_MAJOR_AXIS_METERS = 26_560_000;
const NOMINAL_GPS_PERIOD_SECONDS = 2 * Math.PI * Math.sqrt(
  NOMINAL_GPS_SEMI_MAJOR_AXIS_METERS ** 3 / GPS_MU,
);
const CHANGE_SEMI_MAJOR_AXIS_METERS = 100;
const CHANGE_PERIOD_SECONDS = 0.25;

const PLANES = ["A", "B", "C", "D", "E", "F"];
const PLANE_ANCHORS = { A: 145, B: 205, C: 265, D: 325, E: 25, F: 85 };
const PLANE_COLORS = {
  A: "#0072b2",
  B: "#d55e00",
  C: "#009e73",
  D: "#cc79a7",
  E: "#7a5dc7",
  F: "#9a6b00",
};
const DASHES = ["solid", "dash", "dot", "dashdot", "longdash", "longdashdot"];
const SYMBOLS = ["circle", "square", "diamond", "triangle-up", "triangle-down", "cross"];

const METRICS = {
  periodOffset: { field: "orbitalPeriodOffsetSeconds", label: "Orbital period offset", axis: "Period offset (seconds)" },
  period: { field: "orbitalPeriodSeconds", label: "Orbital period", axis: "Orbital period (seconds)" },
  semiMajorAxis: { field: "semiMajorAxisKilometers", label: "Semi-major axis", axis: "Semi-major axis (km)" },
  semiMajorAxisOffset: { field: "semiMajorAxisOffsetMeters", label: "Semi-major-axis offset", axis: "Semi-major-axis offset (m)" },
  raan: { field: "raanDegrees", label: "RAAN", axis: "RAAN (degrees)", angular: true },
  meanArgumentLatitude: { field: "meanArgumentOfLatitudeDegrees", label: "Mean argument of latitude", axis: "Mean argument of latitude (degrees)", angular: true },
  relativePhase: { field: "relativePhaseDegrees", label: "Relative slot phase", axis: "Relative phase (degrees)", angular: true, relative: true },
  eccentricity: { field: "eccentricity", label: "Eccentricity", axis: "Eccentricity" },
  argumentPerigee: { field: "argumentOfPerigeeDegrees", label: "Argument of perigee", axis: "Argument of perigee (degrees)", angular: true },
  meanAnomaly: { field: "meanAnomalyDegrees", label: "Mean anomaly", axis: "Mean anomaly (degrees)", angular: true },
  raanRate: { field: "raanRateDegreesPerDay", label: "RAAN rate", axis: "RAAN rate (degrees/day)" },
};

function wrap360(value) {
  return ((value % 360) + 360) % 360;
}

function wrap180(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function angularDistance(first, second) {
  return Math.abs(wrap180(first - second));
}

function unwrapAngles(values) {
  if (!values.length) return [];
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    let delta = values[index] - values[index - 1];
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    result.push(result[index - 1] + delta);
  }
  return result;
}

function deriveOrbit(record) {
  const semiMajorAxisMeters = record[5] ** 2;
  const orbitalPeriodSeconds = 2 * Math.PI * Math.sqrt(semiMajorAxisMeters ** 3 / GPS_MU);
  return {
    semiMajorAxisMeters,
    semiMajorAxisKilometers: semiMajorAxisMeters / 1000,
    semiMajorAxisOffsetMeters: semiMajorAxisMeters - NOMINAL_GPS_SEMI_MAJOR_AXIS_METERS,
    orbitalPeriodSeconds,
    orbitalPeriodOffsetSeconds: orbitalPeriodSeconds - NOMINAL_GPS_PERIOD_SECONDS,
    raanDegrees: wrap360(record[6] * 180),
    argumentOfPerigeeDegrees: wrap360(record[7] * 180),
    meanAnomalyDegrees: wrap360(record[8] * 180),
    meanArgumentOfLatitudeDegrees: wrap360((record[7] + record[8]) * 180),
    raanRateDegreesPerDay: record[4] * 180 * 86_400,
  };
}

function circularMean(values, fallback) {
  if (!values.length) return fallback;
  const sum = values.reduce((total, value) => {
    const radians = value * Math.PI / 180;
    total.sin += Math.sin(radians);
    total.cos += Math.cos(radians);
    return total;
  }, { sin: 0, cos: 0 });
  return wrap360(Math.atan2(sum.sin, sum.cos) * 180 / Math.PI);
}

function closestPlane(angle, centers) {
  return PLANES.reduce((best, plane) => {
    const distance = angularDistance(angle, centers[plane]);
    return distance < best.distance ? { plane, distance } : best;
  }, { plane: PLANES[0], distance: Infinity });
}

function clusterCenters(records, initialCenters) {
  let centers = { ...initialCenters };
  const healthyAngles = records.filter((record) => record[1] === 0).map((record) => wrap360(record[6] * 180));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const groups = Object.fromEntries(PLANES.map((plane) => [plane, []]));
    healthyAngles.forEach((angle) => groups[closestPlane(angle, centers).plane].push(angle));
    centers = Object.fromEntries(PLANES.map((plane) => [plane, circularMean(groups[plane], centers[plane])]));
  }
  return centers;
}

function buildHistory(data) {
  const snapshots = data.almanacs
    .map((almanac) => ({ unixSeconds: almanac[0], records: almanac[3] }))
    .sort((first, second) => first.unixSeconds - second.unixSeconds);
  const centersBySnapshot = new Array(snapshots.length);
  let centers = clusterCenters(snapshots.at(-1).records, PLANE_ANCHORS);
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    centers = clusterCenters(snapshots[index].records, centers);
    centersBySnapshot[index] = centers;
  }

  const recordsByPrn = new Map();
  const snapshotsByTime = new Map();
  snapshots.forEach((snapshot, snapshotIndex) => {
    const recordsAtTime = new Map();
    snapshot.records.forEach((raw) => {
      const orbit = deriveOrbit(raw);
      const assignment = closestPlane(orbit.raanDegrees, centersBySnapshot[snapshotIndex]);
      const record = {
        unixSeconds: snapshot.unixSeconds,
        date: new Date(snapshot.unixSeconds * 1000),
        prn: raw[0],
        health: raw[1],
        eccentricity: raw[2],
        sqrtA: raw[5],
        plane: assignment.plane,
        planeDistanceDegrees: assignment.distance,
        planeOutlier: assignment.distance > 20,
        ...orbit,
      };
      if (!recordsByPrn.has(record.prn)) recordsByPrn.set(record.prn, []);
      recordsByPrn.get(record.prn).push(record);
      recordsAtTime.set(record.prn, record);
    });
    snapshotsByTime.set(snapshot.unixSeconds, recordsAtTime);
  });

  for (const records of recordsByPrn.values()) {
    records.sort((first, second) => first.unixSeconds - second.unixSeconds);
    let previous = null;
    records.forEach((record) => {
      record.deltaSemiMajorAxisMeters = previous ? record.semiMajorAxisMeters - previous.semiMajorAxisMeters : 0;
      record.deltaPeriodSeconds = previous ? record.orbitalPeriodSeconds - previous.orbitalPeriodSeconds : 0;
      record.possibleChange = Boolean(previous) && (
        Math.abs(record.deltaSemiMajorAxisMeters) > CHANGE_SEMI_MAJOR_AXIS_METERS ||
        Math.abs(record.deltaPeriodSeconds) > CHANGE_PERIOD_SECONDS
      );
      previous = record;
    });
  }

  const automaticReferences = Object.fromEntries(PLANES.map((plane) => [plane, null]));
  snapshots.forEach((snapshot) => {
    const atTime = snapshotsByTime.get(snapshot.unixSeconds);
    PLANES.forEach((plane) => {
      const healthy = Array.from(atTime.values())
        .filter((record) => record.plane === plane && record.health === 0)
        .sort((first, second) => first.prn - second.prn);
      const previousReference = automaticReferences[plane];
      const reference = healthy.find((record) => record.prn === previousReference) || healthy[0];
      const changed = Boolean(reference) && previousReference !== null && reference.prn !== previousReference;
      if (reference) automaticReferences[plane] = reference.prn;
      Array.from(atTime.values()).filter((record) => record.plane === plane).forEach((record) => {
        record.automaticReferencePrn = reference?.prn ?? null;
        record.automaticReferenceChanged = changed;
        record.relativePhaseDegrees = reference
          ? wrap180(record.meanArgumentOfLatitudeDegrees - reference.meanArgumentOfLatitudeDegrees)
          : NaN;
      });
    });
  });

  const prns = Array.from(recordsByPrn.keys()).sort((a, b) => a - b);
  const currentPlaneByPrn = new Map(prns.map((prn) => [prn, recordsByPrn.get(prn).at(-1).plane]));
  return { snapshots, recordsByPrn, snapshotsByTime, prns, currentPlaneByPrn };
}

function utcPlotValue(date) {
  return date.toISOString().slice(0, 23);
}

function signed(value, digits = 2) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function hoverText(record, referencePrn = null) {
  return [
    `<b>PRN ${String(record.prn).padStart(2, "0")} — Plane ${record.plane}</b>`,
    `${record.date.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Period: ${record.orbitalPeriodSeconds.toFixed(3)} s`,
    `Period offset: ${signed(record.orbitalPeriodOffsetSeconds, 3)} s`,
    `Semi-major axis: ${record.semiMajorAxisKilometers.toFixed(3)} km`,
    `Δa: ${signed(record.semiMajorAxisOffsetMeters, 0)} m`,
    `RAAN: ${record.raanDegrees.toFixed(3)}°`,
    `Mean argument of latitude: ${record.meanArgumentOfLatitudeDegrees.toFixed(3)}°`,
    `Argument of perigee: ${record.argumentOfPerigeeDegrees.toFixed(3)}°`,
    `Mean anomaly: ${record.meanAnomalyDegrees.toFixed(3)}°`,
    `Eccentricity: ${record.eccentricity.toFixed(7)}`,
    `RAAN rate: ${record.raanRateDegreesPerDay.toFixed(5)}°/day`,
    `Health: ${record.health}`,
    `Plane-distance: ${record.planeDistanceDegrees.toFixed(1)}°${record.planeOutlier ? " (outlier)" : ""}`,
    ...(referencePrn ? [`Relative reference: PRN ${String(referencePrn).padStart(2, "0")}`] : []),
    ...(record.possibleChange ? ["<b>Possible orbital change</b>", `Step Δa: ${signed(record.deltaSemiMajorAxisMeters / 1000, 2)} km`, `Step Δperiod: ${signed(record.deltaPeriodSeconds, 2)} s`] : []),
  ].join("<br>");
}

function historyElements() {
  return {
    metric: document.querySelector("#history-metric"),
    start: document.querySelector("#history-start"),
    end: document.querySelector("#history-end"),
    prns: document.querySelector("#history-prns"),
    prnSummary: document.querySelector("#history-prn-summary"),
    highlights: document.querySelector("#history-highlights"),
    highlightSummary: document.querySelector("#history-highlight-summary"),
    planes: document.querySelector("#history-plane-filters"),
    unhealthy: document.querySelector("#history-unhealthy"),
    changes: document.querySelector("#history-changes"),
    angularOptions: document.querySelector("#history-angular-options"),
    referenceControl: document.querySelector("#history-reference-control"),
    reference: document.querySelector("#history-reference"),
    help: document.querySelector("#history-help"),
    chart: document.querySelector("#history-chart"),
    summary: document.querySelector("#history-summary"),
    selectAll: document.querySelector("#history-select-all"),
    clear: document.querySelector("#history-clear"),
    reset: document.querySelector("#history-reset"),
  };
}

function checkedRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function axisLayout(separate, metric, normalized) {
  const yTitle = normalized ? `Change in ${metric.axis.toLowerCase()}` : metric.axis;
  if (!separate) return { yaxis: { title: yTitle, gridcolor: "#e4e0d7", zerolinecolor: "#b9b3a8" } };
  const layout = { grid: { rows: 6, columns: 1, pattern: "independent", roworder: "top to bottom", ygap: 0.04 } };
  PLANES.forEach((plane, index) => {
    const suffix = index === 0 ? "" : String(index + 1);
    layout[`xaxis${suffix}`] = {
      matches: "x",
      showticklabels: index === 5,
      gridcolor: "#e4e0d7",
      title: index === 5 ? "UTC date" : undefined,
    };
    layout[`yaxis${suffix}`] = { title: `Plane ${plane}`, gridcolor: "#e4e0d7", zerolinecolor: "#b9b3a8" };
  });
  layout.annotations = [{
    text: yTitle,
    textangle: -90,
    x: -0.07,
    xref: "paper",
    y: 0.5,
    yref: "paper",
    showarrow: false,
  }];
  return layout;
}

function initializeAlmanacHistory(almanacData) {
  const elements = historyElements();
  if (!elements.chart) return;
  const history = buildHistory(almanacData);
  const selectedPrns = new Set(history.prns);
  const highlightedPrns = new Set();
  const firstDate = new Date(history.snapshots[0].unixSeconds * 1000).toISOString().slice(0, 10);
  const lastDate = new Date(history.snapshots.at(-1).unixSeconds * 1000).toISOString().slice(0, 10);
  elements.start.value = firstDate;
  elements.end.value = lastDate;
  elements.start.min = elements.end.min = firstDate;
  elements.start.max = elements.end.max = lastDate;
  elements.summary.textContent = `${history.snapshots.length.toLocaleString()} snapshots · ${firstDate}–${lastDate}`;

  const schedule = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(render, 80);
    };
  })();

  function updateControlSummaries() {
    elements.prnSummary.textContent = selectedPrns.size === history.prns.length
      ? "All satellites"
      : `${selectedPrns.size} satellite${selectedPrns.size === 1 ? "" : "s"}`;
    elements.highlightSummary.textContent = highlightedPrns.size
      ? Array.from(highlightedPrns).sort((a, b) => a - b).map((prn) => `PRN ${String(prn).padStart(2, "0")}`).join(", ")
      : "None";
    PLANES.forEach((plane) => {
      const planePrns = history.prns.filter((prn) => history.currentPlaneByPrn.get(prn) === plane);
      const checkbox = elements.planes.querySelector(`[data-plane="${plane}"]`);
      checkbox.checked = planePrns.every((prn) => selectedPrns.has(prn));
      checkbox.indeterminate = !checkbox.checked && planePrns.some((prn) => selectedPrns.has(prn));
    });
  }

  function checkbox(prn, highlight = false) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = highlight ? highlightedPrns.has(prn) : selectedPrns.has(prn);
    input.addEventListener("change", () => {
      const target = highlight ? highlightedPrns : selectedPrns;
      if (input.checked) target.add(prn); else target.delete(prn);
      updateControlSummaries();
      schedule();
    });
    label.append(input, ` PRN ${String(prn).padStart(2, "0")}`);
    return label;
  }

  PLANES.forEach((plane) => {
    const group = document.createElement("div");
    group.className = "history-prn-group";
    const title = document.createElement("strong");
    title.textContent = `Plane ${plane}`;
    group.append(title, ...history.prns.filter((prn) => history.currentPlaneByPrn.get(prn) === plane).map((prn) => checkbox(prn)));
    elements.prns.append(group);
    const planeLabel = document.createElement("label");
    const planeInput = document.createElement("input");
    planeInput.type = "checkbox";
    planeInput.dataset.plane = plane;
    planeInput.addEventListener("change", () => {
      history.prns.filter((prn) => history.currentPlaneByPrn.get(prn) === plane).forEach((prn) => {
        if (planeInput.checked) selectedPrns.add(prn); else selectedPrns.delete(prn);
      });
      elements.prns.replaceChildren();
      buildPrnGroups();
      updateControlSummaries();
      schedule();
    });
    planeLabel.style.setProperty("--plane-color", PLANE_COLORS[plane]);
    planeLabel.append(planeInput, ` ${plane}`);
    elements.planes.append(planeLabel);
  });

  function buildPrnGroups() {
    PLANES.forEach((plane) => {
      const group = document.createElement("div");
      group.className = "history-prn-group";
      const title = document.createElement("strong");
      title.textContent = `Plane ${plane}`;
      group.append(title, ...history.prns.filter((prn) => history.currentPlaneByPrn.get(prn) === plane).map((prn) => checkbox(prn)));
      elements.prns.append(group);
    });
  }

  elements.prns.replaceChildren();
  buildPrnGroups();
  elements.highlights.append(...history.prns.map((prn) => checkbox(prn, true)));
  elements.reference.append(...history.prns.map((prn) => {
    const option = document.createElement("option");
    option.value = String(prn);
    option.textContent = `${history.currentPlaneByPrn.get(prn)} · PRN ${String(prn).padStart(2, "0")}`;
    return option;
  }));
  updateControlSummaries();

  function relativeValue(record, referenceSelection) {
    if (referenceSelection === "auto") return { value: record.relativePhaseDegrees, referencePrn: record.automaticReferencePrn, breakBefore: record.automaticReferenceChanged };
    const explicitPrn = Number(referenceSelection);
    const explicit = history.snapshotsByTime.get(record.unixSeconds)?.get(explicitPrn);
    if (explicit && explicit.plane === record.plane) {
      return { value: wrap180(record.meanArgumentOfLatitudeDegrees - explicit.meanArgumentOfLatitudeDegrees), referencePrn: explicitPrn, breakBefore: false };
    }
    return { value: record.relativePhaseDegrees, referencePrn: record.automaticReferencePrn, breakBefore: record.automaticReferenceChanged };
  }

  function render() {
    const metric = METRICS[elements.metric.value];
    const angularMode = checkedRadio("history-angle") || "wrapped";
    const separate = checkedRadio("history-layout") === "planes";
    const normalized = checkedRadio("history-normalize") === "change";
    const referenceSelection = elements.reference.value;
    const start = Date.parse(`${elements.start.value}T00:00:00Z`) / 1000;
    const end = Date.parse(`${elements.end.value}T23:59:59.999Z`) / 1000;
    elements.angularOptions.hidden = !metric.angular;
    elements.referenceControl.hidden = !metric.relative;
    elements.help.textContent = metric.field === "meanArgumentOfLatitudeDegrees"
      ? "Mean argument of latitude = argument of perigee + mean anomaly. It is a mean along-orbit phase coordinate; true argument of latitude uses true anomaly instead."
      : metric.relative
        ? "Relative phase removes common along-track rotation within each plane. Automatic references remain fixed while healthy and series break when a reference must change."
        : "";

    const traces = [];
    const firstInPlane = new Set();
    history.prns.filter((prn) => selectedPrns.has(prn)).forEach((prn) => {
      const allRecords = history.recordsByPrn.get(prn).filter((record) => record.unixSeconds >= start && record.unixSeconds <= end);
      if (!allRecords.length) return;
      const rawValues = allRecords.map((record) => metric.relative
        ? relativeValue(record, referenceSelection)
        : { value: record[metric.field], referencePrn: null, breakBefore: false });
      let values = rawValues.map((entry) => entry.value);
      if (metric.angular && angularMode === "continuous") values = unwrapAngles(values);
      if (normalized) {
        const first = values.find((value, index) =>
          Number.isFinite(value) && (elements.unhealthy.checked || allRecords[index].health === 0));
        if (Number.isFinite(first)) values = values.map((value) => value - first);
      }

      const x = [];
      const y = [];
      const text = [];
      const symbols = [];
      const sizes = [];
      let previousRaw = null;
      allRecords.forEach((record, index) => {
        if (!elements.unhealthy.checked && record.health !== 0) return;
        const rawValue = rawValues[index].value;
        const wrapBreak = metric.angular && angularMode === "wrapped" && previousRaw !== null && Math.abs(rawValue - previousRaw) > 180;
        if (wrapBreak || rawValues[index].breakBefore) {
          x.push(utcPlotValue(record.date));
          y.push(null);
          text.push("");
          symbols.push("circle");
          sizes.push(0);
        }
        x.push(utcPlotValue(record.date));
        y.push(values[index]);
        text.push(hoverText(record, rawValues[index].referencePrn));
        const changeMarker = elements.changes.checked && record.possibleChange;
        symbols.push(changeMarker ? "diamond" : record.health === 0 ? SYMBOLS[prn % SYMBOLS.length] : "x");
        sizes.push(changeMarker ? 9 : record.health === 0 ? 3 : 7);
        previousRaw = rawValue;
      });
      if (!x.length) return;
      const plane = history.currentPlaneByPrn.get(prn);
      const highlighted = highlightedPrns.size === 0 || highlightedPrns.has(prn);
      const planeIndex = PLANES.indexOf(plane);
      traces.push({
        x,
        y,
        text,
        type: "scattergl",
        mode: "lines+markers",
        name: `${plane} · PRN ${String(prn).padStart(2, "0")}`,
        legendgroup: `Plane ${plane}`,
        legendgrouptitle: firstInPlane.has(plane) ? undefined : { text: `Plane ${plane}` },
        xaxis: separate ? `x${planeIndex + 1}` : "x",
        yaxis: separate ? `y${planeIndex + 1}` : "y",
        line: { color: PLANE_COLORS[plane], width: highlighted ? 2.5 : 1, dash: DASHES[prn % DASHES.length] },
        marker: { color: PLANE_COLORS[plane], symbol: symbols, size: sizes, opacity: highlighted ? 0.9 : 0.22 },
        opacity: highlighted ? 0.9 : 0.18,
        connectgaps: false,
        hovertemplate: "%{text}<extra></extra>",
      });
      firstInPlane.add(plane);
    });

    const axes = axisLayout(separate, metric, normalized);
    Plotly.react(elements.chart, traces, {
      ...axes,
      height: separate ? 1020 : 620,
      margin: { l: separate ? 82 : 72, r: 24, t: 20, b: 60 },
      paper_bgcolor: "#fffdf8",
      plot_bgcolor: "#fffdf8",
      hovermode: "closest",
      ...(!separate ? { xaxis: { title: "UTC date", gridcolor: "#e4e0d7" } } : {}),
      legend: { groupclick: "toggleitem", tracegroupgap: 8 },
      annotations: traces.length ? axes.annotations : [{ text: "Select at least one PRN", showarrow: false }],
    }, { responsive: true, displaylogo: false });
  }

  elements.selectAll.addEventListener("click", () => {
    history.prns.forEach((prn) => selectedPrns.add(prn));
    elements.prns.replaceChildren();
    buildPrnGroups();
    updateControlSummaries();
    schedule();
  });
  elements.clear.addEventListener("click", () => {
    selectedPrns.clear();
    elements.prns.replaceChildren();
    buildPrnGroups();
    updateControlSummaries();
    schedule();
  });
  elements.reset.addEventListener("click", () => {
    const update = {};
    for (let index = 1; index <= 6; index += 1) {
      const suffix = index === 1 ? "" : String(index);
      update[`xaxis${suffix}.autorange`] = true;
      update[`yaxis${suffix}.autorange`] = true;
    }
    Plotly.relayout(elements.chart, update);
  });
  [elements.metric, elements.start, elements.end, elements.unhealthy, elements.changes, elements.reference]
    .forEach((element) => element.addEventListener("change", schedule));
  document.querySelectorAll('input[name="history-angle"], input[name="history-layout"], input[name="history-normalize"]')
    .forEach((element) => element.addEventListener("change", schedule));
  render();
}

window.AlmanacHistory = {
  initialize: initializeAlmanacHistory,
  wrap360,
  wrap180,
  unwrapAngles,
  deriveOrbit,
};
