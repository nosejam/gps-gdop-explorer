// SIMD kernel for accumulating receiver geometry at every H3 cell center.
// Two receiver locations are processed in each f64x2 vector.

@inline
function loadVector(pointer: usize, index: i32): v128 {
  return v128.load(pointer + (<usize>index << 3));
}

@inline
function addMasked(pointer: usize, index: i32, value: v128, mask: v128): void {
  const address = pointer + (<usize>index << 3);
  const previous = v128.load(address);
  v128.store(address, f64x2.add(previous, v128.bitselect(value, f64x2.splat(0), mask)));
}

@inline
function gdopAt(normal: usize, count: i32, index: i32): f64 {
  const stride = <usize>count << 3;
  const offset = <usize>index << 3;
  const a00 = load<f64>(normal + offset);
  const a10 = load<f64>(normal + stride + offset);
  const a20 = load<f64>(normal + stride * 2 + offset);
  const a30 = load<f64>(normal + stride * 3 + offset);
  const a11 = load<f64>(normal + stride * 4 + offset);
  const a21 = load<f64>(normal + stride * 5 + offset);
  const a31 = load<f64>(normal + stride * 6 + offset);
  const a22 = load<f64>(normal + stride * 7 + offset);
  const a32 = load<f64>(normal + stride * 8 + offset);
  const a33 = load<f64>(normal + stride * 9 + offset);

  if (a00 <= 0) return NaN;
  const l00 = Math.sqrt(a00);
  const l10 = a10 / l00;
  const l20 = a20 / l00;
  const l30 = a30 / l00;
  const d11 = a11 - l10 * l10;
  if (d11 <= 1e-12) return NaN;
  const l11 = Math.sqrt(d11);
  const l21 = (a21 - l20 * l10) / l11;
  const l31 = (a31 - l30 * l10) / l11;
  const d22 = a22 - l20 * l20 - l21 * l21;
  if (d22 <= 1e-12) return NaN;
  const l22 = Math.sqrt(d22);
  const l32 = (a32 - l30 * l20 - l31 * l21) / l22;
  const d33 = a33 - l30 * l30 - l31 * l31 - l32 * l32;
  if (d33 <= 1e-12) return NaN;
  const l33 = Math.sqrt(d33);

  const m00 = 1 / l00;
  const m11 = 1 / l11;
  const m22 = 1 / l22;
  const m33 = 1 / l33;
  const m10 = -l10 * m00 * m11;
  const m20 = -(l20 * m00 + l21 * m10) / l22;
  const m21 = -l21 * m11 * m22;
  const m30 = -(l30 * m00 + l31 * m10 + l32 * m20) / l33;
  const m31 = -(l31 * m11 + l32 * m21) / l33;
  const m32 = -l32 * m22 * m33;
  const trace =
    m00 * m00 + m10 * m10 + m11 * m11 + m20 * m20 + m21 * m21 + m22 * m22 +
    m30 * m30 + m31 * m31 + m32 * m32 + m33 * m33;
  return trace > 0 ? Math.sqrt(trace) : NaN;
}

export function processStep(
  count: i32,
  receiverX: usize,
  receiverY: usize,
  receiverZ: usize,
  upX: usize,
  upY: usize,
  upZ: usize,
  satelliteX: usize,
  satelliteY: usize,
  satelliteZ: usize,
  satelliteCount: i32,
  elevationSin: f64,
  normal: usize,
  maximum: usize,
  maximumStep: usize,
  visibleAtMaximum: usize,
  step: i32,
): void {
  const stride = <usize>count << 3;
  const zero = f64x2.splat(0);

  for (let index = 0; index < count; index += 2) {
    for (let term = 0; term < 10; term += 1) {
      v128.store(normal + <usize>term * stride + (<usize>index << 3), zero);
    }
    store<u8>(visibleAtMaximum + <usize>count + <usize>index, 0);
    if (index + 1 < count) store<u8>(visibleAtMaximum + <usize>count + <usize>index + 1, 0);
  }

  const maskLimit = f64x2.splat(elevationSin);
  for (let satellite = 0; satellite < satelliteCount; satellite += 1) {
    const sx = f64x2.splat(load<f64>(satelliteX + (<usize>satellite << 3)));
    const sy = f64x2.splat(load<f64>(satelliteY + (<usize>satellite << 3)));
    const sz = f64x2.splat(load<f64>(satelliteZ + (<usize>satellite << 3)));

    for (let index = 0; index < count; index += 2) {
      const dx = f64x2.sub(sx, loadVector(receiverX, index));
      const dy = f64x2.sub(sy, loadVector(receiverY, index));
      const dz = f64x2.sub(sz, loadVector(receiverZ, index));
      const distance = f64x2.sqrt(f64x2.add(
        f64x2.add(f64x2.mul(dx, dx), f64x2.mul(dy, dy)),
        f64x2.mul(dz, dz),
      ));
      const ux = f64x2.div(dx, distance);
      const uy = f64x2.div(dy, distance);
      const uz = f64x2.div(dz, distance);
      const up = f64x2.add(
        f64x2.add(f64x2.mul(ux, loadVector(upX, index)), f64x2.mul(uy, loadVector(upY, index))),
        f64x2.mul(uz, loadVector(upZ, index)),
      );
      let mask = f64x2.ge(up, maskLimit);
      if (index + 1 >= count) {
        mask = f64x2.replace_lane(mask, 1, 0);
      }
      const bits = v128.bitmask<i64>(mask);
      if (bits == 0) continue;

      const visiblePointer = visibleAtMaximum + <usize>count + <usize>index;
      if ((bits & 1) != 0) store<u8>(visiblePointer, load<u8>(visiblePointer) + 1);
      if ((bits & 2) != 0) store<u8>(visiblePointer + 1, load<u8>(visiblePointer + 1) + 1);
      addMasked(normal, index, f64x2.mul(ux, ux), mask);
      addMasked(normal + stride, index, f64x2.mul(ux, uy), mask);
      addMasked(normal + stride * 2, index, f64x2.mul(ux, uz), mask);
      addMasked(normal + stride * 3, index, ux, mask);
      addMasked(normal + stride * 4, index, f64x2.mul(uy, uy), mask);
      addMasked(normal + stride * 5, index, f64x2.mul(uy, uz), mask);
      addMasked(normal + stride * 6, index, uy, mask);
      addMasked(normal + stride * 7, index, f64x2.mul(uz, uz), mask);
      addMasked(normal + stride * 8, index, uz, mask);
      addMasked(normal + stride * 9, index, f64x2.splat(1), mask);
    }
  }

  for (let index = 0; index < count; index += 1) {
    const visible = load<u8>(visibleAtMaximum + <usize>count + <usize>index);
    if (visible < 4) continue;
    const gdop = gdopAt(normal, count, index);
    const maximumPointer = maximum + (<usize>index << 3);
    if (isFinite(gdop) && gdop > load<f64>(maximumPointer)) {
      store<f64>(maximumPointer, gdop);
      store<i32>(maximumStep + (<usize>index << 2), step);
      store<u8>(visibleAtMaximum + <usize>index, visible);
    }
  }
}
