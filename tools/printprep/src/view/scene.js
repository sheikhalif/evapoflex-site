/**
 * The three.js stage: warm-paper ground, the printer's build volume drawn as a
 * quiet wireframe with a shaded plate, orbit controls, and the four material
 * looks a part can wear - solid, ghost, highlight, and plate-preview.
 *
 * The ghost is the part that repays care. Naive transparency sorts wrong the
 * moment two parts overlap on screen, and the joints - which are INSIDE the
 * parts - would lose the depth test outright. The order-independent recipe:
 * joints draw first, opaque, writing depth; shells draw after as an additive
 * Fresnel veil with depth writes off. Additive blending commutes, so no
 * sorting anywhere, and fragments behind a joint are depth-rejected, which is
 * exactly what makes the joint read as "inside".
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const ACCENT = 0x2d7cb5;

export function createStage(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setClearColor(0xeeeee8);
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xeeeee8, 1400, 2600);

  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.position.set(320, -360, 260);
  camera.up.set(0, 0, 1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 40);

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(300, -260, 500);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4e6, 0.7);
  fill.position.set(-400, 300, 200);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(0, 400, -100);
  scene.add(rim);

  const bedGroup = new THREE.Group();
  scene.add(bedGroup);

  const world = new THREE.Group();     // model-space content
  scene.add(world);

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let onFrame = null;
  renderer.setAnimationLoop((t) => {
    controls.update();
    onFrame?.(t);
    renderer.render(scene, camera);
  });

  return {
    renderer, scene, camera, controls, world, bedGroup,
    set onFrame(fn) { onFrame = fn; },
    frameObject(bbox, pad = 1.6) {
      const size = Math.max(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) || 100;
      const c = [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2];
      controls.target.set(c[0], c[1], c[2]);
      const d = size * pad / Math.tan((camera.fov / 2) * Math.PI / 180);
      camera.position.set(c[0] + d * 0.6, c[1] - d * 0.75, c[2] + d * 0.55);

      // The depth cues have to follow the model instead of assuming one.
      // Fog fixed at 1400-2600 mm is a pleasant haze behind a 200 mm bracket
      // and a solid wall of background colour in front of a 967 mm wheel:
      // framing that wheel puts the camera 4.1 m back, every triangle of it
      // lands past the fog's far plane, and the viewport renders completely
      // empty - the model, the parts and the build volume all invisible, with
      // nothing in the console to say why.
      camera.near = Math.max(0.5, d / 2000);
      camera.far = Math.max(5000, d * 6);
      camera.updateProjectionMatrix();
      if (scene.fog) {
        scene.fog.near = d * 1.15;
        scene.fog.far = d * 3.2;
      }
    },
  };
}

/** The build volume: shaded plate, soft grid, wireframe box, exclusion zone. */
export function buildBed(stage, bed, exclude = []) {
  const g = stage.bedGroup;
  while (g.children.length) g.remove(g.children[0]);

  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(bed.x, bed.y),
    new THREE.MeshBasicMaterial({ color: 0xe3dfd7, side: THREE.DoubleSide }));
  plate.position.set(bed.x / 2, bed.y / 2, -0.15);
  g.add(plate);

  const grid = new THREE.GridHelper(Math.max(bed.x, bed.y), Math.max(bed.x, bed.y) / 16, 0xc9c4b8, 0xd8d4c9);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(bed.x / 2, bed.y / 2, -0.05);
  g.add(grid);

  const boxGeo = new THREE.BoxGeometry(bed.x, bed.y, bed.z);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22 }));
  edges.position.set(bed.x / 2, bed.y / 2, bed.z / 2);
  g.add(edges);

  if (exclude.length) {
    const shape = new THREE.Shape(exclude.map(([x, y]) => new THREE.Vector2(x, y)));
    const zone = new THREE.Mesh(new THREE.ShapeGeometry(shape),
      new THREE.MeshBasicMaterial({ color: 0xb5432d, transparent: true, opacity: 0.15, side: THREE.DoubleSide }));
    zone.position.z = 0.05;
    g.add(zone);
  }
  return g;
}

const PALETTE = [0x2d7cb5, 0x4a9fd4, 0x7fb069, 0xd4954a, 0x9b6bb3, 0x5bbfb5, 0xc46a8a, 0x8a8f5c];
export const partColor = (i) => PALETTE[i % PALETTE.length];

export function solidMaterial(color, clippingPlanes = []) {
  return new THREE.MeshStandardMaterial({
    color, metalness: 0.05, roughness: 0.62,
    clippingPlanes, clipShadows: true, side: THREE.DoubleSide,
  });
}

export function edgeMaterial(clippingPlanes = []) {
  return new THREE.LineBasicMaterial({ color: 0x1a1e2a, transparent: true, opacity: 0.55, clippingPlanes });
}

/** The additive Fresnel ghost. depthWrite off, draws after opaque. */
export function ghostMaterial(color = ACCENT, clippingPlanes = []) {
  const c = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    clipping: true, clippingPlanes,
    uniforms: { uColor: { value: new THREE.Vector3(c.r, c.g, c.b) } },
    vertexShader: `
      #include <clipping_planes_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main() {
        #include <begin_vertex>
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <project_vertex>
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV;
      void main() {
        #include <clipping_planes_fragment>
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        gl_FragColor = vec4(uColor * (0.06 + 0.55 * f), 1.0);
      }`,
  });
}

/** Ghost-mode joint look: opaque, warm, clearly not part of the shell. */
export function jointMaterial(male) {
  return new THREE.MeshStandardMaterial({
    color: male ? 0xd4954a : 0x9b6bb3,
    metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide,
  });
}

export function meshFromRender(render, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(render.pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(render.nrm, 3));
  return new THREE.Mesh(geo, material);
}

export function meshFromIndexed(meshData, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(meshData.vertProperties, 3));
  geo.setIndex(new THREE.BufferAttribute(meshData.triVerts, 1));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

export function linesFromSegs(segs, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(segs, 3));
  return new THREE.LineSegments(geo, material);
}
