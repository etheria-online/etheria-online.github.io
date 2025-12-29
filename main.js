// main.js (module) - with configurable enemy speed, wave spawn and periodic respawn
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// --- CONFIG & STATE ---
const CONFIG = {
  worldSize: 4000,
  chunkRes: 128,
  colors: {
    sky: 0x87CEEB,
    ground: 0x7cfc00,
    rock: 0x5a5a5a,
    treeTrunk: 0x8B4513,
    treeLeaves: 0x32CD32
  },
  cameraOffset: new THREE.Vector3(0, 1.6, 0),
  mouseSensitivity: 0.002
};

const state = {
  move: { fwd: false, bwd: false, left: false, right: false },
  sprint: false,
  jump: false,
  onGround: false,
  velocity: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  hp: 100,
  maxHp: 100,
  enemies: [],
  ammo: 30,
  maxAmmo: 30,
  reserveAmmo: 90,
  reloading: false,
  lastShot: 0,
  shootCooldown: 100,
  kills: 0
};

// --- TUNING / SPAWN CONSTANTS (better solution) ---
const PLAYER_RADIUS = 0.6;
const ENEMY_RADIUS = 0.8;
const ENEMY_MIN_DISTANCE_BUFFER = 0.15;
const PLAYER_ATTACK_DAMAGE = 10;

const PLAYER_MOVE_SPEED = 25.0;
const PLAYER_SPRINT_SPEED = 45.0;

// Enemy spawn / speed config
const ENEMY_BASE_SPEED = 6;        // base speed for enemies
const ENEMY_RANDOM_SPEED = 3;      // random additional speed (0..ENEMY_RANDOM_SPEED)
const INITIAL_ENEMY_COUNT = 30;    // how many spawn on game start / reset
const MAX_ENEMIES = 120;           // hard cap of enemies present
const WAVE_SIZE = 6;               // how many to spawn per wave
const WAVE_INTERVAL_MS = 10000;    // spawn wave every 10s

// Globals
let scene, camera, renderer, controls;
let playerObj, terrainMesh, prevTime = performance.now(), raycasterDown, gunGroup, muzzleFlash;
let startBtn, startScreen, inventory, closeInventoryBtn, ammoCounter, hitmarker, killFeed, onScreenLog, startError;
let allowMouseDragFallback = false;
let waveIntervalHandle = null;

// --- Helpers ---
function logOnScreen(msg) {
  if (!onScreenLog) return;
  onScreenLog.style.display = 'block';
  const now = new Date().toLocaleTimeString();
  onScreenLog.innerText = `Logs:\n${now} - ${msg}`;
  console.log(msg);
}

function enableMouseDragFallback() {
  allowMouseDragFallback = true;
  logOnScreen('PointerLock nicht verfügbar — Maus ziehen zum schauen (Linksklick halten).');
}

function getTerrainHeight(x, z) {
  return (Math.sin(x * 0.01) + Math.cos(z * 0.01)) * 10 +
         (Math.sin(x * 0.05) + Math.cos(z * 0.05)) * 2;
}

// --- Pointer lock starter (requests lock on canvas) ---
function tryLock() {
  try {
    logOnScreen('Start requested');
    if (!controls || !renderer) init();
    resetGame();

    try { controls.lock(); } catch (e) { console.warn('controls.lock() failed:', e); }

    const el = renderer && renderer.domElement ? renderer.domElement : document.body;
    if (el && el.requestPointerLock) {
      try { el.requestPointerLock(); } catch (e) { console.warn('requestPointerLock failed:', e); }
    }

    setTimeout(() => {
      if (!startError) startError = document.getElementById('start-error');
      if (document.pointerLockElement !== renderer.domElement) {
        if (startError) {
          startError.textContent = 'Maus konnte nicht gesperrt werden. Fallback aktiviert.';
          startError.style.display = 'block';
        }
        enableMouseDragFallback();
        if (startScreen) startScreen.style.display = 'none';
      } else {
        if (startError) startError.style.display = 'none';
        if (startScreen) startScreen.style.display = 'none';
      }
    }, 200);
  } catch (e) {
    logOnScreen('Error starting game: ' + e);
    alert('Fehler beim Starten des Spiels. Siehe Log auf dem Bildschirm.');
  }
}

// --- DOMContentLoaded: bind UI handlers & init ---
window.addEventListener('DOMContentLoaded', () => {
  startBtn = document.getElementById('start-btn');
  startScreen = document.getElementById('start-screen');
  inventory = document.getElementById('inventory');
  closeInventoryBtn = document.getElementById('close-inventory');
  ammoCounter = document.getElementById('ammo-counter');
  hitmarker = document.getElementById('hitmarker');
  killFeed = document.getElementById('kill-feed');
  onScreenLog = document.getElementById('on-screen-log');
  startError = document.getElementById('start-error');

  if (startBtn) {
    startBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); tryLock(); });
    startBtn.addEventListener('click', (e) => { e.preventDefault(); tryLock(); });
  } else {
    console.error('Start button (#start-btn) not found.');
  }

  if (closeInventoryBtn) closeInventoryBtn.addEventListener('click', () => { inventory.style.display = 'none'; });

  document.querySelectorAll('.menu-icon').forEach(icon => {
    icon.addEventListener('click', () => {
      const text = icon.textContent;
      if (text === 'INV') toggleInventory();
      else alert(`${text} Menü noch nicht implementiert`);
    });
  });

  init();
  animate();
});

// PointerLock global handlers
document.addEventListener('pointerlockchange', () => {
  if (renderer && document.pointerLockElement === renderer.domElement) {
    if (startScreen) startScreen.style.display = 'none';
  } else {
    if (startScreen) startScreen.style.display = 'flex';
  }
});
document.addEventListener('pointerlockerror', () => {
  const errEl = document.getElementById('start-error');
  if (errEl) { errEl.textContent = 'Pointer Lock Fehler: Browser hat das Sperren der Maus verhindert.'; errEl.style.display = 'block'; }
});

// --- INIT / SCENE SETUP ---
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.colors.sky);
  scene.fog = new THREE.FogExp2(CONFIG.colors.sky, 0.0015);
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
  hemiLight.position.set(0, 200, 0);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(50, 200, 100);
  dirLight.castShadow = true;
  scene.add(dirLight);

  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);
  }

  createTerrain();
  createPlayer();
  populateWorld(); // initial spawn uses INITIAL_ENEMY_COUNT inside

  createGun();

  controls = new PointerLockControls(camera, renderer.domElement);
  controls.addEventListener('lock', () => { if (startScreen) startScreen.style.display = 'none'; });
  controls.addEventListener('unlock', () => { if (startScreen) startScreen.style.display = 'flex'; });

  document.addEventListener('keydown', (e) => onKey(e, true));
  document.addEventListener('keyup', (e) => onKey(e, false));
  document.addEventListener('click', shoot);
  window.addEventListener('resize', onWindowResize);

  document.addEventListener('mousemove', (e) => {
    if (!allowMouseDragFallback) return;
    if (e.buttons !== 1) return;
    const sensitivity = 0.0025;
    camera.rotation.y -= e.movementX * sensitivity;
    camera.rotation.x -= e.movementY * sensitivity;
    const max = Math.PI / 2 - 0.01;
    camera.rotation.x = Math.max(-max, Math.min(max, camera.rotation.x));
  });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && startScreen && startScreen.style.display !== 'none') tryLock();
  });

  raycasterDown = new THREE.Raycaster();

  // start wave spawner (if not already running)
  startWaveSpawner();
}

// --- TERRAIN ---
function createTerrain() {
  const geo = new THREE.PlaneGeometry(CONFIG.worldSize, CONFIG.worldSize, CONFIG.chunkRes, CONFIG.chunkRes);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, getTerrainHeight(x, z));
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshToonMaterial({ color: CONFIG.colors.ground, side: THREE.DoubleSide });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
}

// --- WORLD & ENEMY SPAWNING (improved) ---
function populateWorld() {
  // Add trees/rocks as before
  const treeGeo = new THREE.ConeGeometry(3, 12, 8);
  const trunkGeo = new THREE.CylinderGeometry(1, 1, 4, 8);
  const treeMat = new THREE.MeshToonMaterial({ color: CONFIG.colors.treeLeaves });
  const trunkMat = new THREE.MeshToonMaterial({ color: CONFIG.colors.treeTrunk });
  const rockGeo = new THREE.DodecahedronGeometry(3, 0);
  const rockMat = new THREE.MeshToonMaterial({ color: CONFIG.colors.rock });

  for (let i = 0; i < 300; i++) {
    const x = (Math.random() - 0.5) * 1000;
    const z = (Math.random() - 0.5) * 1000;
    const y = getTerrainHeight(x, z);
    if (Math.abs(x) < 20 && Math.abs(z) < 20) continue;
    const type = Math.random();
    if (type > 0.3) {
      const group = new THREE.Group();
      const leaves = new THREE.Mesh(treeGeo, treeMat); leaves.position.y = 6; leaves.castShadow = true;
      const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 2; trunk.castShadow = true;
      group.add(leaves); group.add(trunk);
      group.position.set(x, y, z);
      const s = 0.8 + Math.random() * 1.5; group.scale.set(s, s, s);
      scene.add(group);
    } else {
      const rock = new THREE.Mesh(rockGeo, rockMat);
      rock.position.set(x, y + 2, z);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.scale.setScalar(1 + Math.random() * 3);
      rock.castShadow = true;
      scene.add(rock);
    }
  }

  // spawn initial enemies using the new spawn function
  spawnEnemies(INITIAL_ENEMY_COUNT);
}

/**
 * spawnEnemies(count)
 * - spawns up to `count` new enemies, respecting MAX_ENEMIES
 * - each enemy gets speed = ENEMY_BASE_SPEED + random(0..ENEMY_RANDOM_SPEED)
 */
function spawnEnemies(count = 6) {
  if (!scene) return;
  const canSpawn = Math.max(0, MAX_ENEMIES - state.enemies.length);
  const toSpawn = Math.min(count, canSpawn);
  for (let i = 0; i < toSpawn; i++) {
    // pick a random position away from player center
    let x = (Math.random() - 0.5) * 800;
    let z = (Math.random() - 0.5) * 800;

    const y = getTerrainHeight(x, z);
    if (Math.abs(x) < 50 && Math.abs(z) < 50) {
      // if too close to center, push further out
      const signX = Math.sign(x) || (Math.random() < 0.5 ? -1 : 1);
      const signZ = Math.sign(z) || (Math.random() < 0.5 ? -1 : 1);
      x = signX * (50 + Math.random() * 200);
      z = signZ * (50 + Math.random() * 200);
    }

    const enemyGroup = new THREE.Group();

    const bodyGeo = new THREE.CapsuleGeometry(0.4, 1.0, 4, 8);
    const bodyMat = new THREE.MeshToonMaterial({ color: 0x8B0000 });
    const body = new THREE.Mesh(bodyGeo, bodyMat); body.position.y = 0.8; body.castShadow = true;
    enemyGroup.add(body);

    const headGeo = new THREE.SphereGeometry(0.3, 16, 16);
    const headMat = new THREE.MeshToonMaterial({ color: 0x2F4F4F });
    const head = new THREE.Mesh(headGeo, headMat); head.position.y = 1.5; head.castShadow = true;
    enemyGroup.add(head);

    const eyeGeo = new THREE.SphereGeometry(0.05, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const eyeLeft = new THREE.Mesh(eyeGeo, eyeMat); eyeLeft.position.set(-0.1, 1.5, 0.25);
    const eyeRight = new THREE.Mesh(eyeGeo, eyeMat); eyeRight.position.set(0.1, 1.5, 0.25);
    enemyGroup.add(eyeLeft); enemyGroup.add(eyeRight);

    const armGeo = new THREE.CapsuleGeometry(0.15, 0.6, 4, 8);
    const armLeft = new THREE.Mesh(armGeo, bodyMat); armLeft.position.set(-0.5, 0.8, 0); armLeft.castShadow = true;
    const armRight = new THREE.Mesh(armGeo, bodyMat); armRight.position.set(0.5, 0.8, 0); armRight.castShadow = true;
    enemyGroup.add(armLeft); enemyGroup.add(armRight);

    const legGeo = new THREE.CapsuleGeometry(0.15, 0.6, 4, 8);
    const legLeft = new THREE.Mesh(legGeo, bodyMat); legLeft.position.set(-0.2, 0.1, 0); legLeft.castShadow = true;
    const legRight = new THREE.Mesh(legGeo, bodyMat); legRight.position.set(0.2, 0.1, 0); legRight.castShadow = true;
    enemyGroup.add(legLeft); enemyGroup.add(legRight);

    enemyGroup.position.set(x, y, z);
    scene.add(enemyGroup);

    // push enemy record
    state.enemies.push({
      mesh: enemyGroup,
      speed: ENEMY_BASE_SPEED + Math.random() * ENEMY_RANDOM_SPEED,
      hp: 100,
      attackCooldown: 0,
      attackRate: 1.0 + Math.random() * 0.8,
      radius: ENEMY_RADIUS,
      bodyMesh: body
    });
  }
}

// --- PLAYER & GUN ---
function createPlayer() {
  playerObj = new THREE.Group();
  scene.add(playerObj);

  const bodyGeo = new THREE.CapsuleGeometry(0.5, 1.2, 4, 8);
  const bodyMat = new THREE.MeshToonMaterial({ color: 0x333333 });
  const mesh = new THREE.Mesh(bodyGeo, bodyMat); mesh.position.y = 0.9; mesh.castShadow = true;

  const headGeo = new THREE.SphereGeometry(0.4, 16, 16);
  const headMat = new THREE.MeshToonMaterial({ color: 0xffe0bd });
  const head = new THREE.Mesh(headGeo, headMat); head.position.y = 1.6;

  const hairGeo = new THREE.ConeGeometry(0.5, 0.6, 6);
  const hairMat = new THREE.MeshToonMaterial({ color: 0xff0000 });
  const hair = new THREE.Mesh(hairGeo, hairMat); hair.position.y = 1.9;

  playerObj.add(mesh); playerObj.add(head); playerObj.add(hair);

  playerObj.userData = playerObj.userData || {};
  playerObj.userData.radius = PLAYER_RADIUS;
}

function createGun() {
  gunGroup = new THREE.Group();

  const bodyGeo = new THREE.BoxGeometry(0.08, 0.15, 0.35);
  const bodyMat = new THREE.MeshToonMaterial({ color: 0x1a1a1a });
  const body = new THREE.Mesh(bodyGeo, bodyMat); body.position.set(0.15, -0.15, -0.3); gunGroup.add(body);

  const gripGeo = new THREE.BoxGeometry(0.06, 0.2, 0.1);
  const grip = new THREE.Mesh(gripGeo, bodyMat); grip.position.set(0.15, -0.3, -0.15); grip.rotation.z = -0.3; gunGroup.add(grip);

  const barrelGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.5, 8);
  const barrelMat = new THREE.MeshToonMaterial({ color: 0x0a0a0a });
  const barrel = new THREE.Mesh(barrelGeo, barrelMat); barrel.position.set(0.15, -0.15, -0.55); barrel.rotation.x = Math.PI / 2; gunGroup.add(barrel);

  const sightGeo = new THREE.BoxGeometry(0.02, 0.03, 0.02);
  const sightMat = new THREE.MeshToonMaterial({ color: 0xff9f43 });
  const sight = new THREE.Mesh(sightGeo, sightMat); sight.position.set(0.15, -0.1, -0.75); gunGroup.add(sight);

  const flashGeo = new THREE.SphereGeometry(0.1, 8, 8);
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0 });
  muzzleFlash = new THREE.Mesh(flashGeo, flashMat); muzzleFlash.position.set(0.15, -0.15, -0.8); gunGroup.add(muzzleFlash);

  camera.add(gunGroup);
  scene.add(camera);
}

// --- INPUT & MOVEMENT ---
function onKey(e, pressed) {
  switch (e.code) {
    case 'KeyW': state.move.fwd = pressed; break;
    case 'KeyS': state.move.bwd = pressed; break;
    case 'KeyA': state.move.left = pressed; break;
    case 'KeyD': state.move.right = pressed; break;
    case 'ShiftLeft': state.sprint = pressed; break;
    case 'Space': if (pressed && state.onGround) state.velocity.y = 15; break;
    case 'KeyE': if (pressed) toggleInventory(); break;
    case 'KeyR': if (pressed) reload(); break;
  }
}

function updatePlayerMovement(delta) {
  if ((!controls || !controls.isLocked) && !allowMouseDragFallback) return;

  state.velocity.x -= state.velocity.x * 10.0 * delta;
  state.velocity.z -= state.velocity.z * 10.0 * delta;
  state.velocity.y -= 30.0 * delta;

  state.direction.z = Number(state.move.fwd) - Number(state.move.bwd);
  state.direction.x = Number(state.move.right) - Number(state.move.left);
  if (state.direction.lengthSq() > 0) state.direction.normalize();

  const speed = state.sprint ? PLAYER_SPRINT_SPEED : PLAYER_MOVE_SPEED;

  if (state.move.fwd || state.move.bwd) state.velocity.z -= state.direction.z * speed * delta;
  if (state.move.left || state.move.right) state.velocity.x -= state.direction.x * speed * delta;

  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  euler.setFromQuaternion(camera.quaternion);

  const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);
  forward.y = 0; forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));

  playerObj.position.addScaledVector(forward, -state.velocity.z * delta);
  playerObj.position.addScaledVector(right, -state.velocity.x * delta);
  playerObj.position.y += state.velocity.y * delta;

  const groundHeight = getTerrainHeight(playerObj.position.x, playerObj.position.z);
  if (playerObj.position.y < groundHeight) {
    state.velocity.y = 0;
    playerObj.position.y = groundHeight;
    state.onGround = true;
  } else {
    state.onGround = false;
  }
}

// --- CAMERA ---
function updateCamera() {
  if (playerObj && camera) {
    camera.position.copy(playerObj.position).add(CONFIG.cameraOffset);
  }
}

// --- RESET / RESPAWN ---
function resetGame() {
  if (!playerObj) return;
  const ground = getTerrainHeight(0, 0);
  playerObj.position.set(0, ground + 0.1, 0);
  state.hp = state.maxHp;
  updateHpBar();
  state.enemies.forEach(enemy => scene.remove(enemy.mesh));
  state.enemies = [];
  spawnEnemies(INITIAL_ENEMY_COUNT);
  state.velocity.set(0, 0, 0);
  state.onGround = false;
  if (camera) camera.rotation.set(0, 0, 0);

  // restart wave spawner to respect new counts
  startWaveSpawner();
}

// --- HUD / INVENTORY ---
function toggleInventory() {
  if (!inventory) return;
  inventory.style.display = inventory.style.display === 'none' ? 'block' : 'none';
}

function updateHpBar() {
  const el = document.querySelector('.hp-bar');
  if (el) {
    const pct = Math.max(0, Math.min(1, state.hp / state.maxHp));
    el.style.width = `${pct * 100}%`;
  }
}

function updateAmmoUI() {
  if (ammoCounter) ammoCounter.textContent = `${state.ammo} / ${state.reserveAmmo}`;
}

// --- ENEMY UPDATE (follow, separation, attack, animation) ---
function updateEnemies(delta) {
  if (!playerObj) return;
  const playerPos = playerObj.position.clone();

  // separation so enemies don't stack too much
  for (let i = 0; i < state.enemies.length; i++) {
    const a = state.enemies[i];
    for (let j = i + 1; j < state.enemies.length; j++) {
      const b = state.enemies[j];
      const diff = new THREE.Vector3().subVectors(a.mesh.position, b.mesh.position);
      const dist = diff.length();
      const min = (a.radius || ENEMY_RADIUS) + (b.radius || ENEMY_RADIUS) + 0.05;
      if (dist > 0 && dist < min) {
        const push = diff.normalize().multiplyScalar((min - dist) * 0.5);
        a.mesh.position.add(push);
        b.mesh.position.sub(push);
      }
    }
  }

  for (let i = state.enemies.length - 1; i >= 0; i--) {
    const enemy = state.enemies[i];
    if (!enemy.mesh) continue;

    enemy.attackCooldown = Math.max(0, (enemy.attackCooldown || 0) - delta);

    const dir = new THREE.Vector3().subVectors(playerPos, enemy.mesh.position);
    const dist = dir.length();
    const minDist = (enemy.radius || ENEMY_RADIUS) + PLAYER_RADIUS + ENEMY_MIN_DISTANCE_BUFFER;

    if (dist > minDist) {
      dir.normalize();
      enemy.mesh.position.addScaledVector(dir, enemy.speed * delta);
    } else {
      if (dist > 0.001) {
        dir.normalize();
        enemy.mesh.position.copy(playerPos).addScaledVector(dir, -minDist);
      }

      if (enemy.attackCooldown <= 0) {
        applyDamageToPlayer(PLAYER_ATTACK_DAMAGE);
        enemy.attackCooldown = enemy.attackRate;

        if (enemy.bodyMesh) {
          const origScale = enemy.mesh.scale.clone();
          enemy.mesh.scale.set(origScale.x * 1.2, origScale.y * 1.2, origScale.z * 1.2);
          setTimeout(() => {
            if (enemy.mesh) enemy.mesh.scale.copy(origScale);
          }, 180);

          if (enemy.bodyMesh.material && enemy.bodyMesh.material.color) {
            const mat = enemy.bodyMesh.material;
            const origColor = mat.color.getHex();
            mat.color.setHex(0xff4444);
            setTimeout(() => { if (mat) mat.color.setHex(origColor); }, 200);
          }
        }
      }
    }

    if (enemy.hp <= 0) {
      scene.remove(enemy.mesh);
      state.enemies.splice(i, 1);
      state.kills++;
      const node = document.createElement('div');
      node.className = 'kill-msg';
      node.textContent = `Enemy down (${state.kills})`;
      if (killFeed) {
        killFeed.appendChild(node);
        setTimeout(() => { node.remove(); }, 3000);
      }
    }
  }
}

function applyDamageToPlayer(amount) {
  state.hp = Math.max(0, state.hp - amount);
  updateHpBar();
  if (hitmarker) {
    hitmarker.style.opacity = '1';
    setTimeout(() => { if (hitmarker) hitmarker.style.opacity = '0'; }, 120);
  }
  logOnScreen(`Spieler erhielt ${amount} Schaden. HP=${state.hp}`);
  if (state.hp <= 0) {
    logOnScreen('Spieler gestorben - Respawn in 2s');
    setTimeout(() => {
      resetGame();
      logOnScreen('Respawned');
    }, 2000);
  }
}

// --- SHOOT / RELOAD (improved) ---
function shoot() {
  const now = performance.now();
  if (now - state.lastShot < state.shootCooldown) return;
  if (state.reloading) return;
  if (state.ammo <= 0) { reload(); return; }
  state.lastShot = now;
  state.ammo--;
  updateAmmoUI();

  if (muzzleFlash) {
    muzzleFlash.material.opacity = 1;
    setTimeout(() => { if (muzzleFlash) muzzleFlash.material.opacity = 0; }, 80);
  }

  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const origin = camera.position.clone().add(dir.clone().multiplyScalar(0.5));
  const ray = new THREE.Raycaster(origin, dir);

  const objs = state.enemies.map(e => e.mesh);
  const hits = ray.intersectObjects(objs, true);
  if (hits.length) {
    const hit = hits[0];
    let root = hit.object;
    while (root && !objs.includes(root)) root = root.parent;
    const owner = state.enemies.find(e => e.mesh === root);
    if (owner) {
      owner.hp -= 50;
      if (hitmarker) { hitmarker.style.opacity = '1'; setTimeout(() => { hitmarker.style.opacity = '0'; }, 100); }
      if (owner.bodyMesh) {
        const mat = owner.bodyMesh.material;
        if (mat && mat.color) {
          const orig = mat.color.getHex();
          mat.color.setHex(0xffff66);
          setTimeout(() => { if (mat) mat.color.setHex(orig); }, 140);
        }
      }
    }
  }
}

function reload() {
  if (state.reloading) return;
  if (state.ammo === state.maxAmmo || state.reserveAmmo <= 0) return;
  state.reloading = true;
  setTimeout(() => {
    const needed = state.maxAmmo - state.ammo;
    const taken = Math.min(needed, state.reserveAmmo);
    state.ammo += taken;
    state.reserveAmmo -= taken;
    state.reloading = false;
    updateAmmoUI();
  }, 800);
}

// --- WAVE SPAWNER (periodic) ---
function startWaveSpawner() {
  // clear existing
  if (waveIntervalHandle) clearInterval(waveIntervalHandle);
  waveIntervalHandle = setInterval(() => {
    if (state.enemies.length < MAX_ENEMIES) {
      spawnEnemies(WAVE_SIZE);
      logOnScreen(`Welle: ${WAVE_SIZE} Gegner gespawnt (insgesamt ${state.enemies.length})`);
    }
  }, WAVE_INTERVAL_MS);
}

// --- WINDOW RESIZE & ANIMATE ---
function onWindowResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  requestAnimationFrame(animate);
  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;

  try {
    updatePlayerMovement(delta);
    updateEnemies(delta);
    updateCamera();
    if (renderer && scene && camera) renderer.render(scene, camera);
  } catch (err) {
    console.error('Error during animate:', err);
  }
}
