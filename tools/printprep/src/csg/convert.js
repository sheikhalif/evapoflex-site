/** Manifold Mesh <-> transferable typed arrays, for crossing the worker boundary. */

export function meshOut(m) {
  const mesh = m.getMesh();
  // getMesh copies out of the WASM heap into plain typed arrays, so these are
  // safe to transfer and need no delete().
  const vertProperties = mesh.numProp === 3
    ? mesh.vertProperties
    : stripToPositions(mesh.vertProperties, mesh.numProp);
  return { vertProperties, triVerts: mesh.triVerts, numProp: 3, numVert: mesh.numVert, numTri: mesh.numTri };
}

export function transfersOf(meshLike) {
  return [meshLike.vertProperties.buffer, meshLike.triVerts.buffer];
}

function stripToPositions(src, numProp) {
  const n = src.length / numProp;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = src[i * numProp]; out[i * 3 + 1] = src[i * numProp + 1]; out[i * 3 + 2] = src[i * numProp + 2]; }
  return out;
}

/** Unindexed triangle soup (9 floats per triangle) to the indexed form Manifold wants. */
export function soupToMesh(positions) {
  const numVert = positions.length / 3;
  const triVerts = new Uint32Array(numVert);
  for (let i = 0; i < numVert; i++) triVerts[i] = i;
  return { numProp: 3, vertProperties: positions, triVerts };
}
