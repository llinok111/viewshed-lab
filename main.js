// main.js -- render + interaction only. All measurements come from src/core.mjs;
// nothing is recomputed here. Same module the node benchmarks import.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeViewshed, createField } from './src/core.mjs';

const $ = (id) => document.getElementById(id);
const view = $('view');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(view.clientWidth, view.clientHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090d);
const camera = new THREE.PerspectiveCamera(55, view.clientWidth / view.clientHeight, 0.5, 4000);
camera.position.set(210, 170, 230);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(64, 30, 64);
controls.update();

scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x1a2230, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-160, 220, 120);
scene.add(sun);

const [terrain, expected] = await Promise.all([
  fetch('./data/terrain-128.json').then((r) => r.json()),
  fetch('./data/expected.json').then((r) => r.json()),
]);

const W = terrain.w;
const H = terrain.h;
const field = createField(W, H, terrain.z);

const geometry = new THREE.PlaneGeometry(W - 1, H - 1, W - 1, H - 1);
geometry.rotateX(-Math.PI / 2);
const pos = geometry.attributes.position;
for (let i = 0; i < pos.count; i++) {
  pos.setX(i, pos.getX(i) + (W - 1) / 2);
  pos.setZ(i, pos.getZ(i) + (H - 1) / 2);
  pos.setY(i, field.z[i]);
}
pos.needsUpdate = true;
geometry.computeVertexNormals();
const colors = new Float32Array(pos.count * 3);
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
const material = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.95, metalness: 0.0 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);

const marker = new THREE.Mesh(
  new THREE.ConeGeometry(3.5, 12, 12),
  new THREE.MeshBasicMaterial({ color: 0xffd166 })
);
scene.add(marker);

const state = { x: 64, y: 64, height: 12, azBins: 512 };

function paint(result) {
  const c = geometry.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    if (result.visible[i]) {
      c.setXYZ(i, 0.18 + 0.42 * Math.min(1, Math.max(0, result.slope[i] / 2)), 0.62, 0.42);
    } else {
      c.setXYZ(i, 0.16, 0.18, 0.23);
    }
  }
  c.needsUpdate = true;
}

function recompute() {
  const t0 = performance.now();
  const result = computeViewshed(field, { x: state.x, y: state.y, height: state.height }, { azBins: state.azBins });
  const ms = performance.now() - t0;
  paint(result);
  marker.position.set(state.x, field.z[state.y * W + state.x] + 6, state.y);
  $('cells').textContent = result.cells;
  $('comps').textContent = result.comparisons;
  $('vis').textContent = result.visibleTerrain;
  $('ms').textContent = ms.toFixed(2);
  const refMatch =
    state.x === expected.view.x &&
    state.y === expected.view.y &&
    state.height === expected.view.height &&
    state.azBins === expected.view.azBins;
  $('refVis').textContent = expected.visibleTerrain;
  $('refComps').textContent = expected.comparisons;
  const el = $('agree');
  if (!refMatch) {
    el.textContent = 'move back to the default view';
    el.className = 'warn';
  } else if (result.visibleTerrain === expected.visibleTerrain && result.comparisons === expected.comparisons) {
    el.textContent = `node == browser (${result.visibleTerrain} == ${expected.visibleTerrain})`;
    el.className = 'num';
  } else {
    el.textContent = `MISMATCH browser=${result.visibleTerrain} node=${expected.visibleTerrain}`;
    el.className = 'bad';
  }
}

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downAt = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(mesh)[0];
  if (!hit) return;
  const x = Math.min(W - 1, Math.max(0, Math.round(hit.point.x)));
  const y = Math.min(H - 1, Math.max(0, Math.round(hit.point.z)));
  state.x = x;
  state.y = y;
  recompute();
});

$('height').addEventListener('input', (e) => {
  state.height = Number(e.target.value);
  $('hVal').textContent = state.height;
  recompute();
});
$('azBins').addEventListener('input', (e) => {
  state.azBins = Number(e.target.value);
  $('azVal').textContent = state.azBins;
  recompute();
});

window.addEventListener('resize', () => {
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(view.clientWidth, view.clientHeight);
});

recompute();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
