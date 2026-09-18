const GPS_MU = 3.986005e14;
const EARTH_ROTATION_RATE = 7.2921151467e-5;
const WGS84_A = 6378137.0;
const WGS84_E2 = 6.69437999014e-3;
const SECONDS_PER_WEEK = 604800;

function align(value, alignment = 16) {
  return Math.ceil(value / alignment) * alignment;
}

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

function satellitePositions(almanac, time, outputX, outputY, outputZ, adjustments) {
  const referenceUnixSeconds = almanac[0];
  const toa = almanac[2];
  let count = 0;
  for (const satellite of almanac[3]) {
    const [prn, health, eccentricity, inclinationOffset, ascensionRate, sqrtA, ascension, argumentPerigee, meanAnomaly] = satellite;
    if (health !== 0) continue;
    const semiMajorAxis = sqrtA * sqrtA;
    const meanMotion = Math.sqrt(GPS_MU / (semiMajorAxis ** 3));
    const inclination = (0.3 + inclinationOffset) * Math.PI;
    const timeFromEpoch = wrapWeek(time - referenceUnixSeconds);
    const mean = meanAnomaly * Math.PI + meanMotion * (timeFromEpoch + (adjustments.get(prn) || 0));
    const eccentric = solveEccentricAnomaly(mean, eccentricity);
    const trueAnomaly = Math.atan2(
      Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentric),
      Math.cos(eccentric) - eccentricity,
    );
    const argumentLatitude = trueAnomaly + argumentPerigee * Math.PI;
    const radius = semiMajorAxis * (1 - eccentricity * Math.cos(eccentric));
    const orbitalX = radius * Math.cos(argumentLatitude);
    const orbitalY = radius * Math.sin(argumentLatitude);
    const ascendingNode =
      ascension * Math.PI +
      (ascensionRate * Math.PI - EARTH_ROTATION_RATE) * timeFromEpoch -
      EARTH_ROTATION_RATE * toa;
    const nodeCos = Math.cos(ascendingNode);
    const nodeSin = Math.sin(ascendingNode);
    const inclinationCos = Math.cos(inclination);
    const inclinationSin = Math.sin(inclination);
    outputX[count] = orbitalX * nodeCos - orbitalY * inclinationCos * nodeSin;
    outputY[count] = orbitalX * nodeSin + orbitalY * inclinationCos * nodeCos;
    outputZ[count] = orbitalY * inclinationSin;
    count += 1;
  }
  return count;
}

self.onmessage = async ({ data }) => {
  if (data.type !== "calculate") return;
  try {
    const count = data.latitudes.length;
    const floatBytes = count * Float64Array.BYTES_PER_ELEMENT;
    let pointer = 0;
    const take = (bytes) => {
      const result = pointer;
      pointer = align(pointer + bytes);
      return result;
    };
    const receiverPointers = Array.from({ length: 6 }, () => take(floatBytes));
    const normalPointer = take(floatBytes * 10);
    const maximumPointer = take(floatBytes);
    const maximumStepPointer = take(count * Int32Array.BYTES_PER_ELEMENT);
    const visiblePointer = take(count * 2);
    const satellitePointers = Array.from({ length: 3 }, () => take(32 * Float64Array.BYTES_PER_ELEMENT));
    const pages = Math.ceil(pointer / 65536) + 1;
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const module = await WebAssembly.instantiateStreaming(fetch("wasm/global-gdop.wasm"), {
      env: { memory },
    });
    const wasm = module.instance.exports;
    const arrays = receiverPointers.map((address) => new Float64Array(memory.buffer, address, count));
    const [receiverX, receiverY, receiverZ, upX, upY, upZ] = arrays;

    for (let index = 0; index < count; index += 1) {
      const latitude = data.latitudes[index] * Math.PI / 180;
      const longitude = data.longitudes[index] * Math.PI / 180;
      const sinLat = Math.sin(latitude);
      const cosLat = Math.cos(latitude);
      const sinLon = Math.sin(longitude);
      const cosLon = Math.cos(longitude);
      const radius = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
      receiverX[index] = radius * cosLat * cosLon;
      receiverY[index] = radius * cosLat * sinLon;
      receiverZ[index] = radius * (1 - WGS84_E2) * sinLat;
      upX[index] = cosLat * cosLon;
      upY[index] = cosLat * sinLon;
      upZ[index] = sinLat;
    }

    const maximum = new Float64Array(memory.buffer, maximumPointer, count);
    maximum.fill(-Infinity);
    const maximumStep = new Int32Array(memory.buffer, maximumStepPointer, count);
    maximumStep.fill(-1);
    const satelliteX = new Float64Array(memory.buffer, satellitePointers[0], 32);
    const satelliteY = new Float64Array(memory.buffer, satellitePointers[1], 32);
    const satelliteZ = new Float64Array(memory.buffer, satellitePointers[2], 32);
    const sampleCount = Math.floor((data.endUnixSeconds - data.startUnixSeconds) / data.intervalSeconds) + 1;
    const elevationSin = Math.sin(data.elevationMaskDegrees * Math.PI / 180);
    const adjustments = new Map(data.adjustments || []);

    for (let step = 0; step < sampleCount; step += 1) {
      const time = data.startUnixSeconds + step * data.intervalSeconds;
      const almanac = data.almanacs[nearestAlmanacIndex(data.almanacs, time)];
      const satelliteCount = satellitePositions(almanac, time, satelliteX, satelliteY, satelliteZ, adjustments);
      wasm.processStep(
        count,
        ...receiverPointers,
        ...satellitePointers,
        satelliteCount,
        elevationSin,
        normalPointer,
        maximumPointer,
        maximumStepPointer,
        visiblePointer,
        step,
      );
      if (step % Math.max(1, Math.floor(sampleCount / 200)) === 0 || step + 1 === sampleCount) {
        self.postMessage({
          type: "progress",
          fraction: (step + 1) / sampleCount,
          message: `Global map: processed ${step + 1} of ${sampleCount} time steps…`,
        });
      }
    }

    const resultMaximum = new Float32Array(count);
    const resultStep = new Int32Array(maximumStep);
    const resultVisible = new Uint8Array(memory.buffer, visiblePointer, count).slice();
    for (let index = 0; index < count; index += 1) {
      resultMaximum[index] = Number.isFinite(maximum[index]) ? maximum[index] : NaN;
    }
    self.postMessage({
      type: "result",
      maximum: resultMaximum,
      maximumStep: resultStep,
      visible: resultVisible,
      startUnixSeconds: data.startUnixSeconds,
      intervalSeconds: data.intervalSeconds,
    }, [resultMaximum.buffer, resultStep.buffer, resultVisible.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error.message || String(error) });
  }
};
