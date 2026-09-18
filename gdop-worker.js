const GPS_MU = 3.986005e14;
const EARTH_ROTATION_RATE = 7.2921151467e-5;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const SECONDS_PER_WEEK = 604800;
const EMPTY_ADJUSTMENTS = new Map();

self.onmessage = ({ data }) => {
  if (data.type !== "calculate") return;
  try {
    const result = calculate(data);
    self.postMessage(
      { type: "result", ...result },
      [
        result.times.buffer,
        result.gdop.buffer,
        result.visible.buffer,
        result.satelliteOffsets.buffer,
        result.satelliteAzimuth.buffer,
        result.satelliteElevation.buffer,
        result.satellitePrn.buffer,
      ],
    );
  } catch (error) {
    throw error;
  }
};

function nearestAlmanacIndex(almanacs, unixSeconds) {
  let low = 0;
  let high = almanacs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (almanacs[middle][0] < unixSeconds) low = middle + 1;
    else high = middle;
  }
  if (low === 0) return 0;
  if (low === almanacs.length) return almanacs.length - 1;
  return unixSeconds - almanacs[low - 1][0] <= almanacs[low][0] - unixSeconds ? low - 1 : low;
}

function receiverEcef(latitude, longitude) {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const primeVerticalRadius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: primeVerticalRadius * cosLat * cosLon,
    y: primeVerticalRadius * cosLat * sinLon,
    z: primeVerticalRadius * (1 - WGS84_E2) * sinLat,
    upX: cosLat * cosLon,
    upY: cosLat * sinLon,
    upZ: sinLat,
    sinLat,
    cosLat,
    sinLon,
    cosLon,
  };
}

function wrapWeek(seconds) {
  if (seconds > SECONDS_PER_WEEK / 2) return seconds - SECONDS_PER_WEEK;
  if (seconds < -SECONDS_PER_WEEK / 2) return seconds + SECONDS_PER_WEEK;
  return seconds;
}

function solveEccentricAnomaly(meanAnomaly, eccentricity) {
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const correction =
      (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly) /
      (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= correction;
    if (Math.abs(correction) < 1e-13) break;
  }
  return eccentricAnomaly;
}

function inverseTrace4(values, offset) {
  // Cholesky factorization of the symmetric H^T H matrix.
  const matrix = [
    values[0][offset], values[1][offset], values[2][offset], values[3][offset],
    values[1][offset], values[4][offset], values[5][offset], values[6][offset],
    values[2][offset], values[5][offset], values[7][offset], values[8][offset],
    values[3][offset], values[6][offset], values[8][offset], values[9][offset],
  ];
  const lower = new Float64Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[row * 4 + column];
      for (let k = 0; k < column; k += 1) sum -= lower[row * 4 + k] * lower[column * 4 + k];
      if (row === column) {
        if (sum <= 1e-12) return NaN;
        lower[row * 4 + column] = Math.sqrt(sum);
      } else {
        lower[row * 4 + column] = sum / lower[column * 4 + column];
      }
    }
  }

  let trace = 0;
  for (let diagonal = 0; diagonal < 4; diagonal += 1) {
    const y = new Float64Array(4);
    const x = new Float64Array(4);
    for (let row = 0; row < 4; row += 1) {
      let sum = row === diagonal ? 1 : 0;
      for (let k = 0; k < row; k += 1) sum -= lower[row * 4 + k] * y[k];
      y[row] = sum / lower[row * 4 + row];
    }
    for (let row = 3; row >= 0; row -= 1) {
      let sum = y[row];
      for (let k = row + 1; k < 4; k += 1) sum -= lower[k * 4 + row] * x[k];
      x[row] = sum / lower[row * 4 + row];
    }
    trace += x[diagonal];
  }
  return trace;
}

function processGroup(almanac, times, startIndex, endIndex, receiver, elevationSin, output, visibleOutput, adjustments = EMPTY_ADJUSTMENTS) {
  const count = endIndex - startIndex;
  const maximumSatellites = almanac[3].length;
  const normal = Array.from({ length: 10 }, () => new Float64Array(count));
  const visible = new Uint8Array(count);
  const scratchAzimuth = new Uint16Array(count * maximumSatellites);
  const scratchElevation = new Uint16Array(count * maximumSatellites);
  const scratchPrn = new Uint8Array(count * maximumSatellites);
  const referenceUnixSeconds = almanac[0];
  const toa = almanac[2];

  for (const satellite of almanac[3]) {
    const [prn, health, eccentricity, inclinationOffset, ascensionRate, sqrtA, ascension, argumentPerigee, meanAnomaly] = satellite;
    void prn;
    if (health !== 0) continue;

    const semiMajorAxis = sqrtA * sqrtA;
    const meanMotion = Math.sqrt(GPS_MU / (semiMajorAxis ** 3));
    const inclination = (0.3 + inclinationOffset) * Math.PI;
    const inclinationCos = Math.cos(inclination);
    const inclinationSin = Math.sin(inclination);
    const omega0 = ascension * Math.PI;
    const omegaDot = ascensionRate * Math.PI;
    const omega = argumentPerigee * Math.PI;
    const m0 = meanAnomaly * Math.PI;

    for (let localIndex = 0; localIndex < count; localIndex += 1) {
      const time = times[startIndex + localIndex];
      const timeFromEpoch = wrapWeek(time - referenceUnixSeconds);
      const mean = m0 + meanMotion * (timeFromEpoch + (adjustments.get(prn) || 0));
      const eccentric = solveEccentricAnomaly(mean, eccentricity);
      const trueAnomaly = Math.atan2(
        Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentric),
        Math.cos(eccentric) - eccentricity,
      );
      const argumentLatitude = trueAnomaly + omega;
      const radius = semiMajorAxis * (1 - eccentricity * Math.cos(eccentric));
      const orbitalX = radius * Math.cos(argumentLatitude);
      const orbitalY = radius * Math.sin(argumentLatitude);
      const ascendingNode =
        omega0 + (omegaDot - EARTH_ROTATION_RATE) * timeFromEpoch - EARTH_ROTATION_RATE * toa;
      const nodeCos = Math.cos(ascendingNode);
      const nodeSin = Math.sin(ascendingNode);
      const satelliteX = orbitalX * nodeCos - orbitalY * inclinationCos * nodeSin;
      const satelliteY = orbitalX * nodeSin + orbitalY * inclinationCos * nodeCos;
      const satelliteZ = orbitalY * inclinationSin;

      const dx = satelliteX - receiver.x;
      const dy = satelliteY - receiver.y;
      const dz = satelliteZ - receiver.z;
      const distance = Math.hypot(dx, dy, dz);
      const ux = dx / distance;
      const uy = dy / distance;
      const uz = dz / distance;
      const up = ux * receiver.upX + uy * receiver.upY + uz * receiver.upZ;
      if (up < elevationSin) continue;

      const east = -receiver.sinLon * ux + receiver.cosLon * uy;
      const north =
        -receiver.sinLat * receiver.cosLon * ux -
        receiver.sinLat * receiver.sinLon * uy +
        receiver.cosLat * uz;
      let azimuthDegrees = Math.atan2(east, north) * 180 / Math.PI;
      if (azimuthDegrees < 0) azimuthDegrees += 360;
      const elevationDegrees = Math.asin(Math.max(-1, Math.min(1, up))) * 180 / Math.PI;
      const skySlot = localIndex * maximumSatellites + visible[localIndex];
      scratchAzimuth[skySlot] = Math.min(35_999, Math.round(azimuthDegrees * 100));
      scratchElevation[skySlot] = Math.min(9_000, Math.round(elevationDegrees * 100));
      scratchPrn[skySlot] = prn;

      visible[localIndex] += 1;
      normal[0][localIndex] += ux * ux;
      normal[1][localIndex] += ux * uy;
      normal[2][localIndex] += ux * uz;
      normal[3][localIndex] += ux;
      normal[4][localIndex] += uy * uy;
      normal[5][localIndex] += uy * uz;
      normal[6][localIndex] += uy;
      normal[7][localIndex] += uz * uz;
      normal[8][localIndex] += uz;
      normal[9][localIndex] += 1;
    }
  }

  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const outputIndex = startIndex + localIndex;
    visibleOutput[outputIndex] = visible[localIndex];
    if (visible[localIndex] < 4) {
      output[outputIndex] = NaN;
      continue;
    }
    const inverseTrace = inverseTrace4(normal, localIndex);
    output[outputIndex] = inverseTrace > 0 ? Math.sqrt(inverseTrace) : NaN;
  }

  const observationCount = visible.reduce((sum, value) => sum + value, 0);
  const azimuth = new Uint16Array(observationCount);
  const elevation = new Uint16Array(observationCount);
  const prn = new Uint8Array(observationCount);
  let destination = 0;
  for (let localIndex = 0; localIndex < count; localIndex += 1) {
    const source = localIndex * maximumSatellites;
    const satellitesAtTime = visible[localIndex];
    azimuth.set(scratchAzimuth.subarray(source, source + satellitesAtTime), destination);
    elevation.set(scratchElevation.subarray(source, source + satellitesAtTime), destination);
    prn.set(scratchPrn.subarray(source, source + satellitesAtTime), destination);
    destination += satellitesAtTime;
  }
  return { azimuth, elevation, prn };
}

function calculate(options) {
  const sampleCount = Math.floor(
    (options.endUnixSeconds - options.startUnixSeconds) / options.intervalSeconds,
  ) + 1;
  const times = new Float64Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    times[index] = options.startUnixSeconds + index * options.intervalSeconds;
  }

  const latitude = options.latitudeDegrees * Math.PI / 180;
  const longitude = options.longitudeDegrees * Math.PI / 180;
  const receiver = receiverEcef(latitude, longitude);
  const elevationSin = Math.sin(options.elevationMaskDegrees * Math.PI / 180);
  const gdop = new Float64Array(sampleCount);
  const visible = new Uint8Array(sampleCount);
  const skyChunks = [];
  const adjustments = new Map(options.adjustments || []);

  const groups = [];
  let groupStart = 0;
  let almanacIndex = nearestAlmanacIndex(options.almanacs, times[0]);
  for (let index = 1; index <= sampleCount; index += 1) {
    const nextAlmanac = index < sampleCount
      ? nearestAlmanacIndex(options.almanacs, times[index])
      : -1;
    if (nextAlmanac !== almanacIndex) {
      groups.push([almanacIndex, groupStart, index]);
      groupStart = index;
      almanacIndex = nextAlmanac;
    }
  }

  groups.forEach(([index, start, end], groupNumber) => {
    skyChunks.push(processGroup(
      options.almanacs[index],
      times,
      start,
      end,
      receiver,
      elevationSin,
      gdop,
      visible,
      adjustments,
    ));
    self.postMessage({
      type: "progress",
      fraction: (groupNumber + 1) / groups.length,
      message: `Processed ${end.toLocaleString()} of ${sampleCount.toLocaleString()} samples using ${groupNumber + 1} of ${groups.length} almanac groups…`,
    });
  });

  const satelliteOffsets = new Uint32Array(sampleCount + 1);
  for (let index = 0; index < sampleCount; index += 1) {
    satelliteOffsets[index + 1] = satelliteOffsets[index] + visible[index];
  }
  const observationCount = satelliteOffsets[sampleCount];
  const satelliteAzimuth = new Uint16Array(observationCount);
  const satelliteElevation = new Uint16Array(observationCount);
  const satellitePrn = new Uint8Array(observationCount);
  let observationOffset = 0;
  for (const chunk of skyChunks) {
    satelliteAzimuth.set(chunk.azimuth, observationOffset);
    satelliteElevation.set(chunk.elevation, observationOffset);
    satellitePrn.set(chunk.prn, observationOffset);
    observationOffset += chunk.azimuth.length;
  }

  return {
    times,
    gdop,
    visible,
    satelliteOffsets,
    satelliteAzimuth,
    satelliteElevation,
    satellitePrn,
  };
}
