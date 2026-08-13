import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import RAPIER from '@dimforge/rapier2d-compat';

// ============================================================
// 可調參數 — 手感全在這裡,調完存檔瀏覽器會自動重載
// ============================================================
// S = 人物整體縮放(視覺+物理一起放大,判定框才對得上畫面)。
// 質量用密度 1/S² 補償維持不變;慣性仍 ×S²,所以力矩/肌肉勁度 ×S² 補償。
const S = 1.3;
const CFG = {
  turnTorque: 3.5 * S * S,   // 左右鍵旋轉力道(放大後手臂遠端拖曳變重,多補一點)
  angularDamping: 2.2,
  moveForce: 5.0,            // 質量沒變,推力不用補
  linearDamping: 3.5,
  bodyRadius: 0.45 * S,
  shoulder: 0.36 * S,        // 肩關節側偏
  bladeStart: 0.5,           // 刃部起點(距離肩關節)。刻意不隨 S 放大:
                             // 總觸及要壓在 ~3.0,出生點才能同時離牆、離對手都夠遠
  jointLimit: 1.0,
  shieldLimit: 0.7,
  armStiffness: 3.0 * S * S, // 肌肉彈簧勁度
  armDamping: 0.4,
  weaponDamping: 0.6,
  dmgThreshold: 4.5 * S,     // 尺寸變大甩速線性變快,門檻同步放大
  dmgScale: 4.5,
  hitCooldown: 0.35,
  maxHp: 250,
  aiSwingImpulse: 1.0 * S * S,
  charHeight: 1.35 * S,      // 角色模型身高
  // 體力系統:解「原地陀螺無敵」——高速旋轉燒體力,燒完力竭
  staminaMax: 100,
  spinThreshold: 2.5,        // 角速度超過這個就開始燒體力(中速磨人也會慢慢燒;瞄準用的短暫轉向不痛)
  staminaDrain: 10,          // 每超出 1 rad/s 每秒燒這麼多
  staminaRegen: 25,          // 低速時每秒回復
  recoverAt: 60,             // 力竭後體力回到這裡才解除(~2.4 秒懲罰窗口)
  exhaustedMult: 0.25,       // 力竭時旋轉力剩多少
  exhaustedBrake: 2.5,       // 力竭時額外角速度衰減:強制把旋轉煞停,殘餘轉速才不會繼續殺人
};

// ---------- 裝備定義:模型 + 物理參數 + 價格(每件都不同) ----------
type WeaponDef = { model: string; label: string; length: number; density: number; dmgMult: number; price: number };
type ShieldDef = { model: string; label: string; halfWidth: number; density: number; price: number };
const WEAPONS: Record<string, WeaponDef> = {
  sword1h: { model: 'sword_1handed', label: '短劍', length: 1.15 * S, density: 0.18 / (S * S), dmgMult: 0.8, price: 0 },        // 起始裝備
  axe1h: { model: 'axe_1handed', label: '單手斧', length: 1.1 * S, density: 0.35 / (S * S), dmgMult: 1.3, price: 120 },
  staff: { model: 'staff', label: '長木杖', length: 1.7 * S, density: 0.2 / (S * S), dmgMult: 0.85, price: 150 },
  skelBlade: { model: 'Skeleton_Blade', label: '骷髏彎刀', length: 1.3 * S, density: 0.28 / (S * S), dmgMult: 1.1, price: 200 },
  skelStaff: { model: 'Skeleton_Staff', label: '骨杖', length: 1.8 * S, density: 0.24 / (S * S), dmgMult: 0.95, price: 240 },
  sword2h: { model: 'sword_2handed', label: '雙手大劍', length: 1.6 * S, density: 0.25 / (S * S), dmgMult: 1.0, price: 260 },
  skelAxe: { model: 'Skeleton_Axe', label: '骷髏斧', length: 1.25 * S, density: 0.42 / (S * S), dmgMult: 1.5, price: 300 },
  axe2h: { model: 'axe_2handed', label: '雙手大斧', length: 1.35 * S, density: 0.5 / (S * S), dmgMult: 1.7, price: 380 },
};
const SHIELDS: Record<string, ShieldDef> = {
  badge: { model: 'shield_badge', label: '徽章小盾', halfWidth: 0.34 * S, density: 0.4 / (S * S), price: 0 },                    // 起始裝備
  skelSmallA: { model: 'Skeleton_Shield_Small_A', label: '骨片小盾', halfWidth: 0.36 * S, density: 0.45 / (S * S), price: 80 },
  skelSmallB: { model: 'Skeleton_Shield_Small_B', label: '裂骨小盾', halfWidth: 0.38 * S, density: 0.42 / (S * S), price: 90 },
  round: { model: 'shield_round', label: '圓盾', halfWidth: 0.46 * S, density: 0.5 / (S * S), price: 120 },
  square: { model: 'shield_square', label: '方盾', halfWidth: 0.42 * S, density: 0.55 / (S * S), price: 160 },
  skelLargeA: { model: 'Skeleton_Shield_Large_A', label: '骨牆大盾', halfWidth: 0.48 * S, density: 0.6 / (S * S), price: 200 },
  skelLargeB: { model: 'Skeleton_Shield_Large_B', label: '骸骨大盾', halfWidth: 0.5 * S, density: 0.58 / (S * S), price: 220 },
  spikes: { model: 'shield_spikes', label: '尖刺盾', halfWidth: 0.43 * S, density: 0.65 / (S * S), price: 240 },
};

// ---------- 敵人階梯(按 N 換下一個):一個比一個強,賞金遞增 ----------
type Foe = {
  char: string; label: string; weapon: string; shield: string; tint: number;
  hpMult: number; moveMult: number; swingMult: number; heightMult: number; reward: number;
};
const ENEMY_ROSTER: Foe[] = [
  { char: 'skelMinion', label: '骷髏小兵', weapon: 'skelBlade', shield: 'skelSmallA', tint: 0x88ff88, hpMult: 0.7, moveMult: 0.85, swingMult: 0.8, heightMult: 0.85, reward: 40 },
  { char: 'rogue', label: '盜賊', weapon: 'sword1h', shield: 'badge', tint: 0xdd4466, hpMult: 0.9, moveMult: 1.1, swingMult: 0.9, heightMult: 1.0, reward: 60 },
  { char: 'skelRogue', label: '骷髏遊蕩者', weapon: 'skelBlade', shield: 'skelSmallB', tint: 0x66dd66, hpMult: 1.1, moveMult: 1.15, swingMult: 1.0, heightMult: 0.95, reward: 85 },
  { char: 'rogueHooded', label: '刺客', weapon: 'axe1h', shield: 'square', tint: 0x995544, hpMult: 1.3, moveMult: 1.2, swingMult: 1.05, heightMult: 1.0, reward: 115 },
  { char: 'skelMage', label: '骷髏法師', weapon: 'skelStaff', shield: 'skelSmallB', tint: 0x55ccbb, hpMult: 1.5, moveMult: 1.0, swingMult: 1.1, heightMult: 1.0, reward: 150 },
  { char: 'barbarian', label: '野蠻人', weapon: 'axe2h', shield: 'spikes', tint: 0xff5544, hpMult: 1.8, moveMult: 1.0, swingMult: 1.15, heightMult: 1.05, reward: 190 },
  { char: 'mage', label: '法師', weapon: 'staff', shield: 'round', tint: 0xcc55cc, hpMult: 2.1, moveMult: 1.05, swingMult: 1.25, heightMult: 1.0, reward: 240 },
  { char: 'skelWarrior', label: '骷髏戰士', weapon: 'skelAxe', shield: 'skelLargeA', tint: 0x44ff99, hpMult: 2.5, moveMult: 1.05, swingMult: 1.3, heightMult: 1.08, reward: 300 },
];

// ---------- 存檔:金幣 / 擁有 / 裝備中 ----------
type Save = { gold: number; ownedW: string[]; ownedS: string[]; eqW: string; eqS: string };
function loadSave(): Save {
  const def: Save = { gold: 0, ownedW: ['sword1h'], ownedS: ['badge'], eqW: 'sword1h', eqS: 'badge' };
  try {
    const s = JSON.parse(localStorage.getItem('kd_save') ?? '') as Save;
    if (!WEAPONS[s.eqW]) s.eqW = def.eqW;
    if (!SHIELDS[s.eqS]) s.eqS = def.eqS;
    if (!Array.isArray(s.ownedW) || !s.ownedW.length) s.ownedW = def.ownedW;
    if (!Array.isArray(s.ownedS) || !s.ownedS.length) s.ownedS = def.ownedS;
    s.gold = Math.max(0, s.gold || 0);
    return s;
  } catch { return def; }
}
const SAVE = loadSave();
function persistSave() { localStorage.setItem('kd_save', JSON.stringify(SAVE)); }

// ---------- 場地形狀(按 1-4 切換,記住選擇) ----------
// r = 外接圓半徑。挑法:垂直方向邊距(apothem)都 ≥5.5,
// 出生點(±2.2)到牆的餘裕(3.3)才會大於武器總觸及(~3.2),
// 出生原地空揮不卡牆;同時塞得進鏡頭(垂直半視野 ~6)。
// 鏡頭改為動態跟隨後,場地不用塞進固定視野,可以放大
const ARENA_SHAPES: Record<string, { n: number; offset: number; r: number; label: string }> = {
  circle: { n: 40, offset: 0, r: 7.0, label: '圓形' },
  square: { n: 4, offset: Math.PI / 4, r: 9.0, label: '方形' },
  hex: { n: 6, offset: 0, r: 7.5, label: '六角' },
  oct: { n: 8, offset: Math.PI / 8, r: 7.2, label: '八角' },
};
const SHAPE_KEYS: Record<string, string> = { '1': 'circle', '2': 'square', '3': 'hex', '4': 'oct' };

const app = document.getElementById('app')!;
const msgEl = document.getElementById('msg')!;
const hpFillPlayer = document.querySelector<HTMLDivElement>('#hp-player .hpfill')!;
const hpFillEnemy = document.querySelector<HTMLDivElement>('#hp-enemy .hpfill')!;

function to3D(p: { x: number; y: number }, h = 0): THREE.Vector3 {
  return new THREE.Vector3(p.x, h, -p.y);
}
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function partGroups(knightIndex: number): number {
  const membership = 1 << knightIndex;
  const filter = 0xffff & ~membership;
  return (membership << 16) | filter;
}
const WALL_GROUPS = (0x4 << 16) | 0xffff;

// ---------- 模型自動擺正(量 bbox,不逐件手調) ----------
function fitBlade(src: THREE.Object3D, targetLen: number): THREE.Group {
  const axisRot = new THREE.Group();
  axisRot.add(src.clone(true));
  let box = new THREE.Box3().setFromObject(axisRot);
  const size = box.getSize(new THREE.Vector3());
  if (size.y >= size.x && size.y >= size.z) axisRot.rotation.z = -Math.PI / 2;
  else if (size.z >= size.x && size.z >= size.y) axisRot.rotation.y = Math.PI / 2;
  const flip = new THREE.Group();
  flip.add(axisRot);
  box = new THREE.Box3().setFromObject(flip);
  if (Math.abs(box.min.x) > Math.abs(box.max.x)) flip.rotation.y = Math.PI;
  const outer = new THREE.Group();
  outer.add(flip);
  box = new THREE.Box3().setFromObject(outer);
  const scale = targetLen / (box.max.x - box.min.x);
  flip.position.set(-box.min.x, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2);
  outer.scale.setScalar(scale);
  return outer;
}
function fitShield(src: THREE.Object3D, targetWidth: number): THREE.Group {
  const axisRot = new THREE.Group();
  axisRot.add(src.clone(true));
  let box = new THREE.Box3().setFromObject(axisRot);
  let size = box.getSize(new THREE.Vector3());
  if (size.y <= size.x && size.y <= size.z) axisRot.rotation.z = Math.PI / 2;
  else if (size.z <= size.x && size.z <= size.y) axisRot.rotation.y = Math.PI / 2;
  const swap = new THREE.Group();
  swap.add(axisRot);
  box = new THREE.Box3().setFromObject(swap);
  size = box.getSize(new THREE.Vector3());
  if (size.y > size.z) swap.rotation.x = Math.PI / 2;
  const flip = new THREE.Group();
  flip.add(swap);
  box = new THREE.Box3().setFromObject(flip);
  if ((box.min.x + box.max.x) / 2 < 0) flip.rotation.y = Math.PI;
  const outer = new THREE.Group();
  outer.add(flip);
  box = new THREE.Box3().setFromObject(outer);
  size = box.getSize(new THREE.Vector3());
  const scale = targetWidth / size.z;
  flip.position.set(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2);
  outer.scale.setScalar(scale);
  return outer;
}
function staticPart(root: THREE.Object3D, suffix: RegExp): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && suffix.test(m.name) && !found) found = m;
  });
  if (!found) return null;
  const f = found as THREE.Mesh;
  return new THREE.Mesh(f.geometry, f.material);
}

// ---------- 石板地貼圖(程式生成) ----------
function makeStoneTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3b3733';
  ctx.fillRect(0, 0, 512, 512);
  const rows = 6, cols = 3, th = 512 / rows, tw = 512 / cols;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * tw * 0.5;
    for (let col = -1; col <= cols; col++) {
      const l = 30 + Math.random() * 10;
      ctx.fillStyle = `hsl(${28 + Math.random() * 8}, ${7 + Math.random() * 5}%, ${l}%)`;
      ctx.fillRect(col * tw + off + 3, r * th + 3, tw - 6, th - 6);
      ctx.fillStyle = `rgba(0,0,0,0.12)`;
      for (let i = 0; i < 14; i++) {
        ctx.fillRect(col * tw + off + 4 + Math.random() * (tw - 10), r * th + 4 + Math.random() * (th - 10), 2 + Math.random() * 3, 2 + Math.random() * 3);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

type Models = {
  items: Record<string, THREE.Object3D>;
  chars: Record<string, GLTF>;
};

const CHAR_FILES: Record<string, string> = {
  knight: 'Knight.glb', barbarian: 'Barbarian.glb',
  mage: 'Mage.glb', rogue: 'Rogue.glb', rogueHooded: 'Rogue_Hooded.glb',
  skelMinion: 'Skeleton_Minion.glb', skelRogue: 'Skeleton_Rogue.glb',
  skelMage: 'Skeleton_Mage.glb', skelWarrior: 'Skeleton_Warrior.glb',
};

async function boot() {
  await RAPIER.init();
  const loader = new GLTFLoader();
  // 武器/盾模型都小,全載;角色 GLB 一隻 ~4MB,只載本場要用的兩隻
  const itemNames = [...new Set([
    ...Object.values(WEAPONS).map((w) => w.model),
    ...Object.values(SHIELDS).map((s) => s.model),
  ])];
  const foeIdx = (parseInt(localStorage.getItem('enemyIdx') ?? '0', 10) || 0) % ENEMY_ROSTER.length;
  const charKeys = [...new Set(['knight', ENEMY_ROSTER[foeIdx].char])];
  const loaded = await Promise.all([
    ...charKeys.map((k) => loader.loadAsync(`/models/${CHAR_FILES[k]}`)),
    ...itemNames.map((n) => loader.loadAsync(`/models/${n}.gltf`).then((g) => {
      g.scene.traverse((o) => { o.castShadow = true; });
      return g.scene;
    })),
  ]);
  const chars: Record<string, GLTF> = {};
  charKeys.forEach((k, i) => { chars[k] = loaded[i] as GLTF; });
  const items: Record<string, THREE.Object3D> = {};
  itemNames.forEach((n, i) => { items[n] = loaded[charKeys.length + i] as THREE.Object3D; });
  start({ items, chars });
}
boot();

function start(models: Models) {
  // ---------- Three.js 場景 ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15130f);

  // 動態鏡頭:跟著兩人中點,依距離拉近拉遠(近戰湊近、拉開升高)
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  const camPos = new THREE.Vector3(0, 13, 4.5);
  const camLook = new THREE.Vector3(0, 0, 0);
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  scene.add(new THREE.HemisphereLight(0xccccff, 0x443f33, 0.85));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.3);
  sun.position.set(5, 12, 3);
  sun.castShadow = true;
  sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
  sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  scene.add(sun);
  for (const [lx, lz] of [[-2.8, -2.8], [2.8, 2.8]] as const) {
    const torch = new THREE.PointLight(0xffaa55, 12, 14, 1.6);
    torch.position.set(lx, 2.2, lz);
    scene.add(torch);
  }

  const stoneTex = makeStoneTexture();
  const floorMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x8a8078, roughness: 0.9 });

  // ---------- Rapier 物理世界(俯視角 → 沒有重力) ----------
  const world = new RAPIER.World({ x: 0, y: 0 });

  // ---------- 場地產生器:N 邊形圍牆(圓=40邊) ----------
  const arenaObjs: { bodies: RAPIER.RigidBody[]; meshes: THREE.Object3D[] } = { bodies: [], meshes: [] };
  let arenaShape = localStorage.getItem('arenaShape') ?? 'square';
  if (!ARENA_SHAPES[arenaShape]) arenaShape = 'square';

  function buildArena(key: string) {
    for (const b of arenaObjs.bodies) world.removeRigidBody(b);
    for (const m of arenaObjs.meshes) scene.remove(m);
    arenaObjs.bodies.length = 0;
    arenaObjs.meshes.length = 0;
    const { n, offset, r: R } = ARENA_SHAPES[key];
    // 地板:正 n 邊形(CircleGeometry 本來就是多邊形,圓=多邊到看不出來)
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R + 0.3, n === 40 ? 64 : n, offset), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    arenaObjs.meshes.push(floor);
    // 圍牆:每條邊一段
    const apothem = R * Math.cos(Math.PI / n);
    const halfLen = R * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const phi = offset + (i + 0.5) * (Math.PI * 2) / n;
      const cx = Math.cos(phi) * apothem, cy = Math.sin(phi) * apothem;
      const rot = phi + Math.PI / 2;
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy).setRotation(rot));
      world.createCollider(RAPIER.ColliderDesc.cuboid(halfLen + 0.05, 0.2).setCollisionGroups(WALL_GROUPS), body);
      arenaObjs.bodies.push(body);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(halfLen * 2 + 0.1, 0.9, 0.4), wallMat);
      mesh.position.set(cx, 0.45, -cy);
      mesh.rotation.y = rot;
      mesh.castShadow = true;
      scene.add(mesh);
      arenaObjs.meshes.push(mesh);
    }
    localStorage.setItem('arenaShape', key);
  }
  buildArena(arenaShape);

  type DebrisPart = { mesh: THREE.Object3D; l: { x: number; y: number; z: number } };
  type Arm = {
    rb: RAPIER.RigidBody;
    joint: RAPIER.ImpulseJoint | null;
    group: THREE.Group;
    anchor: { x: number; y: number };
    limit: number;
  };

  // ---------- 武士 ----------
  class Knight {
    rb: RAPIER.RigidBody;
    swordArm: Arm;
    shieldArm: Arm;
    weapon: WeaponDef;
    shield: ShieldDef;
    hp = CFG.maxHp;
    mesh: THREE.Group;
    rig: THREE.Group;
    model: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    walkAction: THREE.AnimationAction | null = null;
    idleAction: THREE.AnimationAction | null = null;
    flashMats: THREE.MeshStandardMaterial[] = [];
    debrisParts: DebrisPart[] = [];
    flashUntil = 0;
    spawn: { x: number; y: number; angle: number };
    swingTimer = 1.0;
    swingDir = 1;
    lastSwingAt = -9;
    stuckTime = 0;
    weaponPreLv = { x: 0, y: 0 };
    weaponPreW = 0;
    bodyPreLv = { x: 0, y: 0 };
    maxHp: number;
    moveMult: number;
    swingMult: number;
    stamina = CFG.staminaMax;
    exhausted = false;

    constructor(x: number, y: number, angle: number, capeTint: number,
      public index: number, public isPlayer: boolean,
      char: GLTF, weaponKey: string, shieldKey: string,
      stats?: { hpMult?: number; moveMult?: number; swingMult?: number; heightMult?: number }) {
      this.spawn = { x, y, angle };
      this.weapon = WEAPONS[weaponKey];
      this.shield = SHIELDS[shieldKey];
      this.maxHp = CFG.maxHp * (stats?.hpMult ?? 1);
      this.hp = this.maxHp;
      this.moveMult = stats?.moveMult ?? 1;
      this.swingMult = stats?.swingMult ?? 1;
      const groups = partGroups(index);

      this.rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y)
          .setRotation(angle)
          .setLinearDamping(CFG.linearDamping)
          .setAngularDamping(CFG.angularDamping)
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(CFG.bodyRadius).setDensity(1.0 / (S * S)).setRestitution(0.2)
          .setCollisionGroups(groups),
        this.rb
      );

      this.swordArm = this.makeArm({ x: 0.05, y: -CFG.shoulder }, CFG.jointLimit);
      this.shieldArm = this.makeArm({ x: 0.05, y: CFG.shoulder }, CFG.shieldLimit);

      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.2 * S, 0.05 * S).setTranslation(0.24 * S, 0).setDensity(0.35 / (S * S))
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(this.weapon.length / 2, 0.04 * S)
          .setTranslation(CFG.bladeStart + this.weapon.length / 2, 0)
          .setDensity(this.weapon.density)
          .setRestitution(0.3)
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.16 * S, 0.05 * S).setTranslation(0.2 * S, 0).setDensity(0.35 / (S * S))
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.07 * S, this.shield.halfWidth).setTranslation(0.48 * S, 0)
          .setDensity(this.shield.density)
          .setRestitution(0.2)
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );

      // ----- 角色模型 -----
      this.mesh = new THREE.Group();
      this.rig = new THREE.Group();
      this.mesh.add(this.rig);
      this.model = cloneSkeleton(char.scene);
      const bbox = new THREE.Box3().setFromObject(this.model);
      const charScale = (CFG.charHeight * (stats?.heightMult ?? 1)) / (bbox.max.y - bbox.min.y);
      this.model.scale.setScalar(charScale);
      const modelYaw = Math.PI / 2;
      this.model.rotation.y = modelYaw;
      this.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (/(Sword|Shield|Axe|Bow|Mug|Offhand|Dagger|Knife|Staff|Wand|Spellbook|Throwable|ArmLeft|ArmRight)/i.test(m.name)) {
          m.visible = false;
          return;
        }
        m.castShadow = true;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        if (/(Cape|Cloak)$/.test(m.name)) mat.color.setHex(capeTint);
        m.material = mat;
        this.flashMats.push(mat);
      });
      this.rig.add(this.model);
      scene.add(this.mesh);

      for (const suffix of [/Body$/, /Head(_Hooded)?$/, /(Helmet|Hat)$/, /Jaw$/, /LegLeft$/, /LegRight$/]) {
        const part = staticPart(char.scene, suffix);
        if (!part) continue;
        part.geometry.computeBoundingBox();
        const center = part.geometry.boundingBox!.getCenter(new THREE.Vector3());
        const wrapper = new THREE.Group();
        part.position.copy(center).negate();
        part.castShadow = true;
        wrapper.add(part);
        wrapper.scale.setScalar(charScale);
        wrapper.rotation.y = modelYaw;
        const l = center.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), modelYaw).multiplyScalar(charScale);
        this.debrisParts.push({ mesh: wrapper, l: { x: l.x, y: Math.max(0.2, l.y), z: l.z } });
      }

      this.mixer = new THREE.AnimationMixer(this.model);
      const walkClip = char.animations.find((a) => a.name === 'Walking_A');
      const idleClip = char.animations.find((a) => a.name === 'Idle');
      if (walkClip) { this.walkAction = this.mixer.clipAction(walkClip); this.walkAction.play(); }
      if (idleClip) { this.idleAction = this.mixer.clipAction(idleClip); this.idleAction.play(); }

      // ----- 物理手臂外觀 -----
      const armRight = staticPart(char.scene, /ArmRight$/);
      const sg = this.swordArm.group;
      if (armRight) {
        const armFit = fitBlade(armRight, 0.5 * S);
        armFit.position.set(0, 0.7 * S, 0);
        armFit.traverse((o) => { o.castShadow = true; });
        sg.add(armFit);
      }
      const weaponModel = fitBlade(models.items[this.weapon.model], CFG.bladeStart + this.weapon.length - 0.25 * S);
      weaponModel.position.set(0.25 * S, 0.72 * S, 0);
      sg.add(weaponModel);

      const armLeft = staticPart(char.scene, /ArmLeft$/);
      const hg = this.shieldArm.group;
      if (armLeft) {
        const armFit = fitBlade(armLeft, 0.45 * S);
        armFit.position.set(0, 0.66 * S, 0);
        armFit.traverse((o) => { o.castShadow = true; });
        hg.add(armFit);
      }
      const shieldModel = fitShield(models.items[this.shield.model], this.shield.halfWidth * 2 + 0.05);
      shieldModel.position.set(0.5 * S, 0.62 * S, 0);
      hg.add(shieldModel);
    }

    makeArm(anchor: { x: number; y: number }, limit: number): Arm {
      const a = this.spawn.angle;
      const px = this.spawn.x + anchor.x * Math.cos(a) - anchor.y * Math.sin(a);
      const py = this.spawn.y + anchor.x * Math.sin(a) + anchor.y * Math.cos(a);
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(px, py)
          .setRotation(a)
          .setLinearDamping(CFG.weaponDamping)
          .setAngularDamping(CFG.weaponDamping)
      );
      const group = new THREE.Group();
      scene.add(group);
      const arm: Arm = { rb, joint: null, group, anchor, limit };
      this.attachArm(arm);
      return arm;
    }
    attachArm(arm: Arm) {
      if (arm.joint) return;
      const jd = RAPIER.JointData.revolute({ x: arm.anchor.x, y: arm.anchor.y }, { x: 0, y: 0 });
      arm.joint = world.createImpulseJoint(jd, this.rb, arm.rb, true);
      arm.joint.setContactsEnabled(false);
      const rev = arm.joint as RAPIER.RevoluteImpulseJoint;
      // 注意:JointData 上的 limitsEnabled/limits 欄位在這版不會生效,要用 setLimits()
      rev.setLimits(-arm.limit, arm.limit);
      rev.configureMotorPosition(0, CFG.armStiffness, CFG.armDamping);
    }
    dropArms() {
      for (const arm of [this.swordArm, this.shieldArm]) {
        if (!arm.joint) continue;
        world.removeImpulseJoint(arm.joint, true);
        arm.joint = null;
      }
    }

    get pos() { return this.rb.translation(); }
    get angle() { return this.rb.rotation(); }

    captureVel() {
      const lv = this.rb.linvel();
      this.bodyPreLv = { x: lv.x, y: lv.y };
      const wv = this.swordArm.rb.linvel();
      this.weaponPreLv = { x: wv.x, y: wv.y };
      this.weaponPreW = this.swordArm.rb.angvel();
    }

    forward(force: number, dt: number) {
      const a = this.angle;
      this.rb.applyImpulse({ x: Math.cos(a) * force * dt, y: Math.sin(a) * force * dt }, true);
    }
    turn(torque: number, dt: number) {
      // 旋轉力隨體力衰減:體力越低轉越沒力,低體力重啟的旋轉軟弱無害
      const mult = this.exhausted
        ? CFG.exhaustedMult
        : CFG.exhaustedMult + (1 - CFG.exhaustedMult) * (this.stamina / CFG.staminaMax);
      this.rb.applyTorqueImpulse(torque * mult * dt, true);
    }

    // 體力:高速旋轉燒,低速回;燒完力竭到回滿門檻才解除
    updateStamina(dt: number) {
      const w = this.rb.angvel();
      const aw = Math.abs(w);
      if (aw > CFG.spinThreshold) this.stamina -= (aw - CFG.spinThreshold) * CFG.staminaDrain * dt;
      else this.stamina += CFG.staminaRegen * dt;
      this.stamina = THREE.MathUtils.clamp(this.stamina, 0, CFG.staminaMax);
      if (this.stamina <= 0) this.exhausted = true;
      else if (this.exhausted && this.stamina >= CFG.recoverAt) this.exhausted = false;
      // 力竭:強制煞停旋轉(不然殘餘轉速還能繼續當攪拌機)
      if (this.exhausted) this.rb.setAngvel(w * Math.max(0, 1 - CFG.exhaustedBrake * dt), true);
    }

    reset() {
      this.hp = this.maxHp;
      this.rb.setTranslation({ x: this.spawn.x, y: this.spawn.y }, true);
      this.rb.setRotation(this.spawn.angle, true);
      this.rb.setLinvel({ x: 0, y: 0 }, true);
      this.rb.setAngvel(0, true);
      const a = this.spawn.angle;
      for (const arm of [this.swordArm, this.shieldArm]) {
        const px = this.spawn.x + arm.anchor.x * Math.cos(a) - arm.anchor.y * Math.sin(a);
        const py = this.spawn.y + arm.anchor.x * Math.sin(a) + arm.anchor.y * Math.cos(a);
        arm.rb.setTranslation({ x: px, y: py }, true);
        arm.rb.setRotation(a, true);
        arm.rb.setLinvel({ x: 0, y: 0 }, true);
        arm.rb.setAngvel(0, true);
        this.attachArm(arm);
      }
      this.swingTimer = 1.0;
      this.lastSwingAt = -9;
      this.stuckTime = 0;
      this.stamina = CFG.staminaMax;
      this.exhausted = false;
      this.rig.visible = true;
      for (const arm of [this.swordArm, this.shieldArm]) arm.group.visible = true;
    }

    sync(now: number, dt: number) {
      const p = this.pos;
      this.mesh.position.set(p.x, 0, -p.y);
      this.mesh.rotation.y = this.angle;

      for (const arm of [this.swordArm, this.shieldArm]) {
        const w = arm.rb.translation();
        arm.group.position.set(w.x, 0, -w.y);
        arm.group.rotation.y = arm.rb.rotation();
      }

      const lv = this.rb.linvel();
      const bw = this.rb.angvel();
      const speed = Math.hypot(lv.x, lv.y);
      const w = THREE.MathUtils.clamp(speed / 1.4, 0, 1);
      if (this.walkAction) {
        this.walkAction.setEffectiveWeight(w);
        this.walkAction.timeScale = 0.5 + speed * 0.45;
      }
      if (this.idleAction) this.idleAction.setEffectiveWeight(1 - w);
      this.mixer.update(dt);
      const a = this.angle;
      const fwdSpeed = lv.x * Math.cos(a) + lv.y * Math.sin(a);
      this.rig.rotation.x = THREE.MathUtils.clamp(fwdSpeed * 0.03, -0.12, 0.12);
      this.rig.rotation.z = THREE.MathUtils.clamp(-bw * 0.03, -0.15, 0.15);

      const flash = now < this.flashUntil ? 0x881111 : 0x000000;
      for (const m of this.flashMats) m.emissive.setHex(flash);
    }
  }

  // 出生點刻意不完全對稱:完全對稱會讓兩把武器「刃尖頂刃尖」形成穩定僵局
  // 出生點:離牆 > 武器觸及(~3.05) > 離對手身體,出生原地空揮才不卡牆也砍不到人
  const enemyIdx = (parseInt(localStorage.getItem('enemyIdx') ?? '0', 10) || 0) % ENEMY_ROSTER.length;
  const foe = ENEMY_ROSTER[enemyIdx];
  const player = new Knight(-2.6, 0, 0, 0x5588ff, 0, true, models.chars.knight, SAVE.eqW, SAVE.eqS);
  const enemy = new Knight(2.6, 0.8, Math.PI + 0.3, foe.tint, 1, false, models.chars[foe.char], foe.weapon, foe.shield, foe);
  document.getElementById('label-enemy')!.textContent = `敵人(${foe.label}·賞金${foe.reward})`;

  // ---------- 金幣 HUD + 鐵匠鋪 ----------
  const goldEl = document.getElementById('gold')!;
  const staminaEl = document.getElementById('stamina-player')!;
  const staminaFill = staminaEl.querySelector<HTMLDivElement>('.stfill')!;
  const shopEl = document.getElementById('shop')!;
  const shopItemsEl = document.getElementById('shop-items')!;
  let shopOpen = false;
  function updateGold() { goldEl.textContent = `💰 ${SAVE.gold}`; }
  function weightLabel(rawDensity: number): string {
    const d = rawDensity * S * S;
    return d >= 0.4 ? '重' : d >= 0.24 ? '中' : '輕';
  }
  function renderShop() {
    let html = '<h3>武器</h3>';
    for (const [k, w] of Object.entries(WEAPONS)) {
      const owned = SAVE.ownedW.includes(k);
      const eq = SAVE.eqW === k;
      const cant = !owned && SAVE.gold < w.price;
      html += `<div class="srow"><span class="sname">${w.label}</span>
        <span class="sstat">長 ${w.length.toFixed(1)}|${weightLabel(w.density)}|威力 x${w.dmgMult}</span>
        <button data-t="w" data-k="${k}" class="${eq ? 'eq' : cant ? 'cant' : ''}">${eq ? '裝備中' : owned ? '裝備' : `${w.price} 金`}</button></div>`;
    }
    html += '<h3>盾牌</h3>';
    for (const [k, s] of Object.entries(SHIELDS)) {
      const owned = SAVE.ownedS.includes(k);
      const eq = SAVE.eqS === k;
      const cant = !owned && SAVE.gold < s.price;
      html += `<div class="srow"><span class="sname">${s.label}</span>
        <span class="sstat">寬 ${(s.halfWidth * 2).toFixed(1)}|${weightLabel(s.density)}</span>
        <button data-t="s" data-k="${k}" class="${eq ? 'eq' : cant ? 'cant' : ''}">${eq ? '裝備中' : owned ? '裝備' : `${s.price} 金`}</button></div>`;
    }
    shopItemsEl.innerHTML = html;
    shopItemsEl.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.t!, k = btn.dataset.k!;
        const isW = t === 'w';
        const def = isW ? WEAPONS[k] : SHIELDS[k];
        const owned = isW ? SAVE.ownedW : SAVE.ownedS;
        if (!owned.includes(k)) {
          if (SAVE.gold < def.price) return;
          SAVE.gold -= def.price;
          owned.push(k);
          persistSave();
          updateGold();
          renderShop();
        } else if ((isW ? SAVE.eqW : SAVE.eqS) !== k) {
          if (isW) SAVE.eqW = k; else SAVE.eqS = k;
          persistSave();
          location.reload(); // 裝備綁在建構期(碰撞體+模型),重載最乾淨
        }
      });
    });
  }
  function toggleShop(open?: boolean) {
    shopOpen = open ?? !shopOpen;
    shopEl.classList.toggle('open', shopOpen);
    if (shopOpen) renderShop();
  }
  updateGold();
  (window as unknown as Record<string, unknown>).__game = { player, enemy, CFG, WEAPONS, SHIELDS };

  // ---------- 噴血粒子 ----------
  const bloodGeo = new THREE.BoxGeometry(0.07, 0.07, 0.07);
  const bloodMat = new THREE.MeshBasicMaterial({ color: 0xaa0000 });
  const particles: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  function spawnBlood(at: THREE.Vector3, count: number) {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(bloodGeo, bloodMat);
      mesh.position.copy(at);
      const a = Math.random() * Math.PI * 2;
      const s = 1 + Math.random() * 3;
      particles.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * s, 2 + Math.random() * 3, Math.sin(a) * s),
        life: 0.5 + Math.random() * 0.3,
      });
      scene.add(mesh);
    }
  }
  function updateParticles(dt: number) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.life -= dt;
      pt.vel.y -= 9.8 * dt;
      pt.mesh.position.addScaledVector(pt.vel, dt);
      if (pt.mesh.position.y < 0.03) { pt.mesh.position.y = 0.03; pt.vel.set(0, 0, 0); }
      if (pt.life <= 0) { scene.remove(pt.mesh); particles.splice(i, 1); }
    }
  }

  // ---------- 地上血泊 ----------
  const poolGeo = new THREE.CircleGeometry(1, 24);
  const poolMat = new THREE.MeshBasicMaterial({ color: 0x550000, transparent: true, opacity: 0.85 });
  const pools: { mesh: THREE.Mesh; age: number }[] = [];
  function spawnPool(at: THREE.Vector3) {
    const mesh = new THREE.Mesh(poolGeo, poolMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, 0.02 + pools.length * 0.002, at.z);
    mesh.scale.setScalar(0.01);
    pools.push({ mesh, age: 0 });
    scene.add(mesh);
  }
  function updatePools(dt: number) {
    for (const p of pools) {
      p.age += dt;
      p.mesh.scale.setScalar(Math.min(1, p.age * 1.5) * 0.9 * S);
    }
  }

  // ---------- 死亡碎裂 ----------
  type Debris = {
    mesh: THREE.Object3D; rb: RAPIER.RigidBody;
    h: number; vy: number; spinAxis: THREE.Vector3; spin: number;
  };
  const debris: Debris[] = [];
  function shatter(k: Knight, impact: { x: number; y: number }) {
    k.rig.visible = false;
    const p = k.pos, a = k.angle;
    const mag = Math.hypot(impact.x, impact.y) || 1;
    const ix = impact.x / mag, iy = impact.y / mag;

    k.dropArms();
    for (const arm of [k.swordArm, k.shieldArm]) {
      arm.rb.applyImpulse({ x: ix * 0.12 + (Math.random() - 0.5) * 0.1, y: iy * 0.12 + (Math.random() - 0.5) * 0.1 }, true);
      arm.rb.applyTorqueImpulse((Math.random() - 0.5) * 1.2, true);
    }

    for (const part of k.debrisParts) {
      const wx = p.x + part.l.x * Math.cos(a) + part.l.z * Math.sin(a);
      const wy = p.y + part.l.x * Math.sin(a) - part.l.z * Math.cos(a);
      const mesh = part.mesh.clone(true);
      mesh.position.set(wx, part.l.y, -wy);
      scene.add(mesh);
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(wx, wy)
          .setLinearDamping(2.5).setAngularDamping(3)
      );
      world.createCollider(RAPIER.ColliderDesc.ball(0.13 * S).setDensity(0.4 / (S * S)).setRestitution(0.4), rb);
      rb.applyImpulse({
        x: ix * (0.07 + Math.random() * 0.07) + (Math.random() - 0.5) * 0.06,
        y: iy * (0.07 + Math.random() * 0.07) + (Math.random() - 0.5) * 0.06,
      }, true);
      debris.push({
        mesh, rb, h: part.l.y, vy: 1 + Math.random() * 2.5,
        spinAxis: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: (Math.random() - 0.5) * 14,
      });
    }
    spawnBlood(to3D({ x: p.x, y: p.y }, 0.7 * S), 40);
    spawnPool(to3D({ x: p.x, y: p.y }));
  }
  function updateDebris(dt: number) {
    for (const d of debris) {
      d.vy -= 9.8 * dt;
      d.h += d.vy * dt;
      if (d.h < 0.15 && d.vy < 0) {
        d.h = 0.15;
        d.vy = Math.abs(d.vy) > 0.8 ? -d.vy * 0.35 : 0;
      }
      const t = d.rb.translation();
      d.mesh.position.set(t.x, d.h, -t.y);
      if (d.vy !== 0 || Math.abs(d.spin) > 0.1) d.mesh.rotateOnAxis(d.spinAxis, d.spin * dt);
      d.spin *= 1 - Math.min(1, 2.5 * dt);
    }
  }
  function clearBattlefield() {
    for (const d of debris) { scene.remove(d.mesh); world.removeRigidBody(d.rb); }
    debris.length = 0;
    for (const p of pools) scene.remove(p.mesh);
    pools.length = 0;
    for (const pt of particles) scene.remove(pt.mesh);
    particles.length = 0;
  }

  // ---------- 傷害判定 ----------
  let gameOver = false;
  let clock = 0;
  const lastHitAt = new Map<string, number>();

  function updateHpBars() {
    hpFillPlayer.style.width = `${(player.hp / player.maxHp) * 100}%`;
    hpFillEnemy.style.width = `${(enemy.hp / enemy.maxHp) * 100}%`;
  }

  function swordHitCheck(attacker: Knight, victim: Knight) {
    if (gameOver) return;
    const wp = attacker.swordArm.rb.translation();
    const wa = attacker.swordArm.rb.rotation();
    const v = victim.pos;
    const dirx = Math.cos(wa), diry = Math.sin(wa);
    const bx = wp.x + dirx * CFG.bladeStart, by = wp.y + diry * CFG.bladeStart;

    let t = (v.x - bx) * dirx + (v.y - by) * diry;
    t = Math.max(0, Math.min(attacker.weapon.length, t));
    const cx = bx + dirx * t, cy = by + diry * t;
    if (Math.hypot(v.x - cx, v.y - cy) > CFG.bodyRadius + 0.12 * S) return;

    const key = attacker.isPlayer ? 'p->e' : 'e->p';
    if (clock - (lastHitAt.get(key) ?? -9) < CFG.hitCooldown) return;

    const lv = attacker.weaponPreLv, w = attacker.weaponPreW;
    const rx = cx - wp.x, ry = cy - wp.y;
    const vv = victim.bodyPreLv;
    const impact = { x: lv.x - w * ry - vv.x, y: lv.y + w * rx - vv.y };
    const relSpeed = Math.hypot(impact.x, impact.y);
    const dmg = Math.max(0, relSpeed - CFG.dmgThreshold) * CFG.dmgScale * attacker.weapon.dmgMult;
    if (dmg <= 0) return;

    lastHitAt.set(key, clock);
    victim.hp = Math.max(0, victim.hp - dmg);
    victim.flashUntil = clock + 0.12;
    spawnBlood(to3D({ x: cx, y: cy }, 0.8 * S), Math.min(30, Math.round(dmg * 1.5)));
    updateHpBars();

    if (victim.hp <= 0) {
      gameOver = true;
      shatter(victim, impact);
      if (victim.isPlayer) {
        msgEl.textContent = '你被擊敗了 — 按 R 再來';
      } else {
        SAVE.gold += foe.reward;
        persistSave();
        updateGold();
        msgEl.textContent = `你贏了!+${foe.reward} 金幣 — R 再打|N 下一個對手|B 鐵匠鋪`;
      }
      msgEl.style.display = 'block';
    }
  }

  // ---------- 輸入 ----------
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow')) e.preventDefault();
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'r') restart();
    if (k === 'b') toggleShop();
    if (k === 'n') {
      // 換下一個對手:重載頁面重建(角色/武器/碎裂部件全綁在建構期)
      localStorage.setItem('enemyIdx', String((enemyIdx + 1) % ENEMY_ROSTER.length));
      location.reload();
    }
    if (SHAPE_KEYS[k]) {
      arenaShape = SHAPE_KEYS[k];
      buildArena(arenaShape);
      restart(); // 換場地把人拉回出生點,避免卡在新牆外
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  function restart() {
    clearBattlefield();
    player.reset();
    enemy.reset();
    gameOver = false;
    msgEl.style.display = 'none';
    updateHpBars();
  }

  // ---------- 簡單 AI(距離門檻跟著人物尺寸走) ----------
  function updateAI(dt: number) {
    const p = player.pos, e = enemy.pos;
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const targetAngle = Math.atan2(dy, dx);
    const diff = wrapAngle(targetAngle - enemy.angle);

    // 反陀螺:玩家的刀還在轉、或快要能轉(力竭尾聲體力回升)就退到掃不到的地方等
    const playerSpinning = Math.abs(player.rb.angvel()) > 2.5 || (player.exhausted && player.stamina >= 45);
    const spinReach = 0.49 + CFG.bladeStart + player.weapon.length + 0.5; // 玩家武器掃得到的半徑+安全邊
    if (playerSpinning) {
      const w = enemy.rb.angvel();
      enemy.turn(diff * 6 - w * 1.5, dt); // 面向盯著
      if (dist < spinReach) {
        // 直線遠離(不管面向);被牆擋住退不動就往側面滑
        const ux = -dx / dist, uy = -dy / dist;
        enemy.rb.applyImpulse({ x: ux * CFG.moveForce * enemy.moveMult * dt, y: uy * CFG.moveForce * enemy.moveMult * dt }, true);
        const lv2 = enemy.rb.linvel();
        if (Math.hypot(lv2.x, lv2.y) < 0.3) {
          const side = Math.sin(clock * 2) > 0 ? 1 : -1; // 穩定的側向,不亂抖
          enemy.rb.applyImpulse({ x: -uy * side * CFG.moveForce * dt, y: ux * side * CFG.moveForce * dt }, true);
        }
      }
      return; // 不出手也不進場,等
    }

    // 懲罰模式:玩家力竭(刀也停了)→全速撲上去加倍出手;
    // 體力回到 45 就提前撤(等刀真的轉起來才跑會被蹭到,物理上逃不掉)
    if (player.exhausted && player.stamina < 45) {
      const w = enemy.rb.angvel();
      enemy.turn(diff * 8 - w * 1.5, dt);
      if (dist > 1.5) {
        enemy.rb.applyImpulse({
          x: (dx / dist) * CFG.moveForce * 1.5 * enemy.moveMult * dt,
          y: (dy / dist) * CFG.moveForce * 1.5 * enemy.moveMult * dt,
        }, true);
      }
      enemy.swingTimer -= dt * 2;
      if (enemy.swingTimer <= 0 && dist < 2.9 * S) {
        enemy.swingDir *= -1;
        enemy.rb.applyTorqueImpulse(enemy.swingDir * CFG.aiSwingImpulse * enemy.swingMult, true);
        enemy.swingTimer = (1.1 + Math.random() * 0.8) / enemy.swingMult;
        enemy.lastSwingAt = clock;
      }
      return;
    }

    enemy.swingTimer -= dt;
    if (enemy.swingTimer <= 0 && dist < 2.8 * S) {
      enemy.swingDir *= -1;
      enemy.rb.applyTorqueImpulse(enemy.swingDir * CFG.aiSwingImpulse * enemy.swingMult * (enemy.exhausted ? 0.3 : 1), true);
      enemy.swingTimer = (1.1 + Math.random() * 0.8) / enemy.swingMult;
      enemy.lastSwingAt = clock;
    } else if (clock - enemy.lastSwingAt > 0.5) {
      const w = enemy.rb.angvel();
      enemy.turn(diff * 6 - w * 1.5, dt);
    }
    if (dist > 2.0 * S && Math.abs(diff) < 0.7) enemy.forward(CFG.moveForce * enemy.moveMult, dt);
    else if (dist < 1.2 * S) enemy.forward(-CFG.moveForce * 0.6, dt);

    const lv = enemy.rb.linvel();
    if (dist > 2.0 * S && Math.hypot(lv.x, lv.y) < 0.4) enemy.stuckTime += dt;
    else enemy.stuckTime = 0;
    if (enemy.stuckTime > 0.7) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const a2 = enemy.angle;
      enemy.rb.applyImpulse({ x: -Math.sin(a2) * side * 1.5, y: Math.cos(a2) * side * 1.5 }, true);
      enemy.stuckTime = 0;
    }
  }

  // ---------- 主迴圈 ----------
  let last = performance.now();
  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    clock += dt;

    if (!gameOver && !shopOpen) {
      if (keys.has('arrowleft') || keys.has('a')) player.turn(CFG.turnTorque, dt);
      if (keys.has('arrowright') || keys.has('d')) player.turn(-CFG.turnTorque, dt);
      if (keys.has('arrowup') || keys.has('w')) player.forward(CFG.moveForce, dt);
      if (keys.has('arrowdown') || keys.has('s')) player.forward(-CFG.moveForce * 0.7, dt);
      updateAI(dt);
    }

    player.updateStamina(dt);
    enemy.updateStamina(dt);
    staminaEl.classList.toggle('exhausted', player.exhausted);
    staminaFill.style.width = `${player.stamina}%`;

    player.captureVel();
    enemy.captureVel();
    world.step();
    swordHitCheck(player, enemy);
    swordHitCheck(enemy, player);

    player.sync(clock, dt);
    enemy.sync(clock, dt);
    updateParticles(dt);
    updatePools(dt);
    updateDebris(dt);

    // 動態鏡頭:中點跟隨 + 距離縮放,指數平滑不暈
    const pp = player.pos, ep = enemy.pos;
    const midX = (pp.x + ep.x) / 2, midY = (pp.y + ep.y) / 2;
    const sep = Math.hypot(pp.x - ep.x, pp.y - ep.y);
    const h = THREE.MathUtils.clamp(8 + sep * 1.1, 10.5, 16.5);
    const k = 1 - Math.exp(-3 * dt);
    camPos.lerp(new THREE.Vector3(midX, h, -midY + h * 0.35), k);
    camLook.lerp(new THREE.Vector3(midX, 0, -midY), k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
