import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js?module';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js?module';
import { MeshSurfaceSampler } from 'https://unpkg.com/three@0.160.0/examples/jsm/math/MeshSurfaceSampler.js?module';
import * as BufferGeometryUtils from 'https://unpkg.com/three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js';

//
// === Scene / Camera / Renderer Setup ===
//

// 1) Grab the container <div id="hero">
const container = document.querySelector('#hero');
if (!container) {
  console.error('No element found with selector "#hero". Make sure your HTML has <div id="hero"></div>');
}

// 2) Use the container’s dimensions for camera aspect & renderer size
let width  = container.clientWidth;
let height = container.clientHeight;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  75,
  width / height,
  0.1,
  1000
);
camera.position.z = 60;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(width, height);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

//
// === Particle + Morphing Parameters ===
//
const particleCount = 12000;
const speed         = 0.4;   // speed of morphing animation
const morphDuration = 8;     // seconds to morph cloud ↔ model
const pauseDuration = 1;     // seconds to pause at fully formed model
const morphFraction = 0.8;   // 80% of dots participate each cycle

//
// Pre‐allocate Float32Arrays for positions
//
const cloudPositions  = new Float32Array(particleCount * 3);
const modelPositions  = new Float32Array(particleCount * 3);
const positions       = new Float32Array(particleCount * 3);
const randomOffsets   = new Float32Array(particleCount);

//
// Boolean mask: which particles are “active” this cycle (1 = will morph, 0 = always scattered).
//
let isActive = new Uint8Array(particleCount);

//
// State for morphing
//
let state           = 'toModel';
let stateStartTime  = 0;
const clock         = new THREE.Clock();

//
// Each model may optionally include a `transfer` object with:
//
//   transfer: {
//     position: { x: Number, y: Number, z: Number },   // translation offset
//     rotation: { x: Number, y: Number, z: Number },   // Euler‐angles (in radians)
//   }
//
// If absent, we fall back to the random offset/rotation already in place.
//
const models = [
  {
    file: 'network.glb',
    scale: 0.05,
    transfer: {
      position: { x: 0, y: 0, z: 2 },
      rotation: {
        x: Math.PI / 5,
        y: Math.PI / 5,
        z: 0,
      }
    }
  },
  {
    file: 'rocket.glb',
    scale: 0.005,
    transfer: {
      position: { x: 0, y: 0, z: 2 },
      rotation: {
        x: -Math.PI / 2,
        y: -Math.PI / 3,
        z: Math.PI / 2,
      }
    }
  },
  {
    file: 'satellite.glb',
    scale: 0.6
  },
  {
    file: 'space_suit.glb',
    scale: 0.5,
    transfer: {
      position: { x: 0, y: 0, z: 2 },
      rotation: {
        x: -Math.PI / 2,
        y: Math.PI / 4,
        z: Math.PI / 12,
      }
    }
  },
];

let currentModelIndex = 0;
const modelsData = []; // will hold { sampler, scale, transfer } for each model
const loader     = new GLTFLoader();

//
// Geometry & Material (declare once; attribute added after loading models)
//
const geometry = new THREE.BufferGeometry();
let material, particles;
const colors = new Float32Array(particleCount * 3);

//
// Utility: Simple white‐circle texture for PointsMaterial
//
function generateSolidCircleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  return new THREE.CanvasTexture(canvas);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function easeInOutCubic(x) {
  return x < 0.5
    ? 4 * x * x * x
    : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function applyFlowOffset(baseX, baseY, baseZ, i, t, out) {
  const phase = randomOffsets[i] + t;
  const swirlRadius = 1.4 + Math.sin(t + i * 0.09) * 0.45;

  // Low-frequency pseudo-noise terms for softer, organic movement.
  const flowX = Math.sin(baseY * 0.06 + t * 0.7 + i * 0.003) * 0.55;
  const flowY = Math.cos(baseZ * 0.05 + t * 0.5 + i * 0.002) * 0.4;
  const flowZ = Math.sin(baseX * 0.05 + t * 0.65 + i * 0.004) * 0.55;

  out.x = baseX + Math.sin(phase + baseY * 0.1) * swirlRadius + flowX;
  out.y = baseY + Math.sin(t * 0.75 + i * 0.01) * 0.45 + flowY;
  out.z = baseZ + Math.cos(phase + baseY * 0.1) * swirlRadius + flowZ;
}

//
// STEP 1: Load all models and build MeshSurfaceSampler for each.
// Once done, call onModelsLoaded().
//
function loadAllModels(onModelsLoaded) {
  let loadedCount = 0;

  models.forEach((entry, idx) => {
    loader.load(entry.file, (gltf) => {
      const geoms = [];
      gltf.scene.traverse((node) => {
        if (node.isMesh && node.geometry) {
          node.updateMatrixWorld(true);
          const cloned = node.geometry.clone();
          cloned.applyMatrix4(node.matrixWorld);
          geoms.push(cloned);
        }
      });

      if (geoms.length === 0) {
        console.error(`No meshes found in ${entry.file}`);
        return;
      }

      // Merge all mesh geometries into one buffer
      const merged = BufferGeometryUtils.mergeBufferGeometries(geoms, false);
      merged.computeVertexNormals();
      merged.computeBoundingBox();

      // Center the geometry on (0,0,0)
      const center = new THREE.Vector3();
      merged.boundingBox.getCenter(center);
      merged.translate(-center.x, -center.y, -center.z);

      // Build the sampler
      const sampler = new MeshSurfaceSampler({ geometry: merged }).build();

      const transfer = entry.transfer || null;
      modelsData[idx] = {
        sampler,
        scale: entry.scale,
        transfer
      };

      loadedCount += 1;
      if (loadedCount === models.length) {
        onModelsLoaded();
      }
    });
  });
}

//
// STEP 2: Once models are loaded, generate cloud data,
//         pick initial active set, generate modelPositions,
//         set up geometry & material, then start.
//
loadAllModels(() => {
  generateCloudData();
  regenerateIsActive();                  // pick first random 80%
  generateModelPositions(currentModelIndex, modelPositions);

  // Initially upload cloud positions
  positions.set(cloudPositions);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  material = new THREE.PointsMaterial({
    map: generateSolidCircleTexture(),
    color: 0xffffff,
    vertexColors: true,
    size: 0.3,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.NormalBlending,
    alphaTest: 0.01
  });

  particles = new THREE.Points(geometry, material);
  scene.add(particles);

  // Begin in "toModel" state
  state = 'toModel';
  stateStartTime = clock.getElapsedTime();

  animate();
});

//
// Generate random cloud (scattered) positions + swirl‐phase offsets.
// cloudPositions remain fixed across all cycles.
//
function generateCloudData() {
  for (let i = 0; i < particleCount; i++) {
    const i3 = i * 3;
    cloudPositions[i3]     = (Math.random() - 0.5) * 80;
    cloudPositions[i3 + 1] = (Math.random() - 0.5) * 80;
    cloudPositions[i3 + 2] = (Math.random() - 0.5) * 80;
    randomOffsets[i]       = Math.random() * Math.PI * 2;
  }
}

//
// Each cycle, pick a new random subset of ~80% of particles to be “active”.
// Those active will move into/out of the model; others stay purely scattered.
//
function regenerateIsActive() {
  isActive.fill(0);
  const targetCount = Math.floor(particleCount * morphFraction);
  let count = 0;
  while (count < targetCount) {
    const idx = Math.floor(Math.random() * particleCount);
    if (isActive[idx] === 0) {
      isActive[idx] = 1;
      count++;
    }
  }
}

const tempPosition = new THREE.Vector3();
const tempFlow = new THREE.Vector3();

//
// Fill modelPositions for every particle—regardless of active. But only active ones will be used.
// Each particle gets a sampled position on the mesh, then is scaled/rotated/translated
// according to either the model’s transfer (if specified) or a random transform.
//
function generateModelPositions(index, outArray) {
  const { sampler, scale, transfer } = modelsData[index];

  // Determine a single rotationMatrix and offset for all particles of this model:
  let rotationMatrix, offsetVector;

  if (transfer && transfer.rotation) {
    const { x: rx, y: ry, z: rz } = transfer.rotation;
    rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(rx, ry, rz)
    );
  } else {
    // Random “small” rotation as before:
    const randomEuler = new THREE.Euler(
      (Math.random() - 0.5) * Math.PI * 0.2,
      (Math.random() - 0.5) * Math.PI * 0.4,
      (Math.random() - 0.5) * Math.PI * 0.2
    );
    rotationMatrix = new THREE.Matrix4().makeRotationFromEuler(randomEuler);
  }

  if (transfer && transfer.position) {
    const { x: px, y: py, z: pz } = transfer.position;
    offsetVector = new THREE.Vector3(px, py, pz);
  } else {
    offsetVector = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 6
    );
  }

  for (let i = 0; i < particleCount; i++) {
    const i3 = i * 3;

    sampler.sample(tempPosition);
    tempPosition.multiplyScalar(scale);
    tempPosition.applyMatrix4(rotationMatrix);
    tempPosition.add(offsetVector);

    outArray[i3]     = tempPosition.x;
    outArray[i3 + 1] = tempPosition.y;
    outArray[i3 + 2] = tempPosition.z;
  }
}

//
// === Animation Loop & State Machine ===
//
function animate() {
  requestAnimationFrame(animate);

  const time    = clock.getElapsedTime();
  const elapsed = time - stateStartTime;
  const t       = time * speed;
  const posArray = geometry.attributes.position.array;
  const colorArray = geometry.attributes.color.array;

  if (state === 'toModel') {
    // Interpolate from cloud → model for active particles
    const factor = easeInOutCubic(Math.min(elapsed / morphDuration, 1.0));

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      if (isActive[i] === 1) {
        const w  = factor;
        const cX = cloudPositions[i3],
              cY = cloudPositions[i3 + 1],
              cZ = cloudPositions[i3 + 2];
        const mX = modelPositions[i3],
              mY = modelPositions[i3 + 1],
              mZ = modelPositions[i3 + 2];

        const baseX = cX * (1 - w) + mX * w;
        const baseY = cY * (1 - w) + mY * w;
        const baseZ = cZ * (1 - w) + mZ * w;

        applyFlowOffset(baseX, baseY, baseZ, i, t, tempFlow);
        posArray[i3]     = tempFlow.x;
        posArray[i3 + 1] = tempFlow.y;
        posArray[i3 + 2] = tempFlow.z;
      } else {
        const cX = cloudPositions[i3],
              cY = cloudPositions[i3 + 1],
              cZ = cloudPositions[i3 + 2];
        applyFlowOffset(cX, cY, cZ, i, t, tempFlow);
        posArray[i3]     = tempFlow.x;
        posArray[i3 + 1] = tempFlow.y;
        posArray[i3 + 2] = tempFlow.z;
      }
    }

    if (elapsed >= morphDuration) {
      state = 'pause';
      stateStartTime = time;
    }
  }
  else if (state === 'pause') {
    // Hold at model for active; scatter for others
    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      if (isActive[i] === 1) {
        posArray[i3]     = modelPositions[i3];
        posArray[i3 + 1] = modelPositions[i3 + 1];
        posArray[i3 + 2] = modelPositions[i3 + 2];
      } else {
        const cX = cloudPositions[i3],
              cY = cloudPositions[i3 + 1],
              cZ = cloudPositions[i3 + 2];
        applyFlowOffset(cX, cY, cZ, i, t, tempFlow);
        posArray[i3]     = tempFlow.x;
        posArray[i3 + 1] = tempFlow.y;
        posArray[i3 + 2] = tempFlow.z;
      }
    }

    if (elapsed >= pauseDuration) {
      state = 'toCloud';
      stateStartTime = time;
    }
  }
  else if (state === 'toCloud') {
    // Interpolate model → cloud for active; scatter for others
    const factor = easeInOutCubic(Math.min(elapsed / morphDuration, 1.0));

    for (let i = 0; i < particleCount; i++) {
      const i3 = i * 3;
      if (isActive[i] === 1) {
        const w  = factor;
        const mX = modelPositions[i3],
              mY = modelPositions[i3 + 1],
              mZ = modelPositions[i3 + 2];
        const cX = cloudPositions[i3],
              cY = cloudPositions[i3 + 1],
              cZ = cloudPositions[i3 + 2];

        const baseX = mX * (1 - w) + cX * w;
        const baseY = mY * (1 - w) + cY * w;
        const baseZ = mZ * (1 - w) + cZ * w;

        applyFlowOffset(baseX, baseY, baseZ, i, t, tempFlow);
        posArray[i3]     = tempFlow.x;
        posArray[i3 + 1] = tempFlow.y;
        posArray[i3 + 2] = tempFlow.z;
      } else {
        const cX = cloudPositions[i3],
              cY = cloudPositions[i3 + 1],
              cZ = cloudPositions[i3 + 2];
        applyFlowOffset(cX, cY, cZ, i, t, tempFlow);
        posArray[i3]     = tempFlow.x;
        posArray[i3 + 1] = tempFlow.y;
        posArray[i3 + 2] = tempFlow.z;
      }
    }

    if (elapsed >= morphDuration) {
      // Fully “cloud” now → next model, regenerate active set, recompute modelPositions
      currentModelIndex = (currentModelIndex + 1) % models.length;
      regenerateIsActive();
      generateModelPositions(currentModelIndex, modelPositions);

      state = 'toModel';
      stateStartTime = time;
    }
  }

  // Depth-based tint/brightness: brighter and cooler near camera, dimmer farther away.
  for (let i = 0; i < particleCount; i++) {
    const i3 = i * 3;
    const z = posArray[i3 + 2];
    const depth = clamp01((z + 60) / 120);
    const nearBoost = clamp01((camera.position.z - z) / 130);

    const r = 0.45 + depth * 0.35 + nearBoost * 0.12;
    const g = 0.56 + depth * 0.34 + nearBoost * 0.14;
    const b = 0.72 + depth * 0.23 + nearBoost * 0.06;

    colorArray[i3]     = clamp01(r);
    colorArray[i3 + 1] = clamp01(g);
    colorArray[i3 + 2] = clamp01(b);
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
  renderer.render(scene, camera);
}

//
// Resize handler (measure container’s size instead of window)
//
window.addEventListener('resize', () => {
  width  = container.clientWidth;
  height = container.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
});
