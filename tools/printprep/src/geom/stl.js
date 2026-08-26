/**
 * STL reading and writing.
 *
 * STL is a bag of loose triangles with no shared vertices and no topology, which
 * is why everything downstream starts with a weld. Both the binary and the ASCII
 * dialects are handled; the binary sniff is byte-length arithmetic rather than
 * the "solid" prefix, because plenty of binary exporters write "solid" into the
 * 80-byte header and the prefix test then reads them as ASCII.
 */

/** @returns {{positions: Float32Array, triCount: number, name: string}} */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  return isBinarySTL(bytes) ? parseBinary(buffer) : parseAscii(new TextDecoder().decode(bytes));
}

function isBinarySTL(bytes) {
  if (bytes.length < 84) return false;
  // A binary file is exactly 84 + 50*n bytes. That is a much stronger signal
  // than the leading keyword.
  const n = new DataView(bytes.buffer, bytes.byteOffset, 84).getUint32(80, true);
  if (84 + n * 50 === bytes.length) return true;
  // Truncated or padded binary files exist. Fall back to looking for a NUL or a
  // high byte in the first 512 bytes, neither of which occurs in ASCII STL.
  const probe = Math.min(512, bytes.length);
  for (let i = 0; i < probe; i++) if (bytes[i] === 0 || bytes[i] > 126) return true;
  return false;
}

function parseBinary(buffer) {
  const dv = new DataView(buffer);
  const declared = dv.getUint32(80, true);
  const available = Math.floor((buffer.byteLength - 84) / 50);
  const triCount = Math.min(declared, available);
  const positions = new Float32Array(triCount * 9);
  let o = 84, p = 0;
  for (let i = 0; i < triCount; i++) {
    o += 12;                                   // the per-facet normal is discarded
    for (let k = 0; k < 9; k++, o += 4) positions[p++] = dv.getFloat32(o, true);
    o += 2;                                    // attribute byte count
  }
  const name = decodeHeaderName(new Uint8Array(buffer, 0, 80));
  return { positions, triCount, name };
}

function decodeHeaderName(head) {
  let s = '';
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === 0) break;
    if (c < 32 || c > 126) return '';
    s += String.fromCharCode(c);
  }
  return s.trim().replace(/^solid\s*/i, '').slice(0, 64);
}

function parseAscii(text) {
  const name = (text.match(/^\s*solid\s+([^\r\n]*)/i)?.[1] || '').trim().slice(0, 64);
  // One pass with a global regex beats splitting into lines: large ASCII STLs are
  // tens of millions of characters and the array of line strings alone is
  // gigabytes.
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) { out.push(+m[1], +m[2], +m[3]); }
  const triCount = Math.floor(out.length / 9);
  return { positions: new Float32Array(out.slice(0, triCount * 9)), triCount, name };
}

/**
 * Write binary STL from an indexed mesh.
 *
 * Facet normals are recomputed from the winding rather than carried through,
 * because a stale normal that disagrees with the winding is the classic way to
 * confuse a slicer, and every consumer recomputes them anyway.
 */
export function writeSTL(vertProperties, triVerts, { numProp = 3, name = 'evapoflex' } = {}) {
  const nTri = triVerts.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const head = new TextEncoder().encode(('evapoflex print prep: ' + name).slice(0, 79));
  new Uint8Array(buf, 0, 80).set(head);
  dv.setUint32(80, nTri, true);

  let o = 84;
  const ax = new Float64Array(3), bx = new Float64Array(3), cx = new Float64Array(3);
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      const i0 = triVerts[t * 3] * numProp, i1 = triVerts[t * 3 + 1] * numProp, i2 = triVerts[t * 3 + 2] * numProp;
      ax[k] = vertProperties[i0 + k]; bx[k] = vertProperties[i1 + k]; cx[k] = vertProperties[i2 + k];
    }
    const ux = bx[0] - ax[0], uy = bx[1] - ax[1], uz = bx[2] - ax[2];
    const vx = cx[0] - ax[0], vy = cx[1] - ax[1], vz = cx[2] - ax[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
    for (const v of [ax, bx, cx]) {
      dv.setFloat32(o, v[0], true); dv.setFloat32(o + 4, v[1], true); dv.setFloat32(o + 8, v[2], true); o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
