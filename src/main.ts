import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import RAPIER from '@dimforge/rapier2d-compat';

// ============================================================
// 可調參數 — 手感全在這裡,調完存檔瀏覽器會自動重載
// ============================================================
const CFG = {
  turnTorque: 2.6,      // 左右鍵旋轉力道(甩劍的力量來源)
  angularDamping: 2.2,  // 旋轉阻尼:越大越鈍重、極速越低
  moveForce: 5.0,       // 前後移動力道
  linearDamping: 3.5,   // 移動阻尼
  bodyRadius: 0.45,     // 身體(圓)半徑
  shoulder: 0.36,       // 肩關節在身體側面的偏移(左右對稱)
  bladeStart: 0.5,      // 刃部起點(距離肩關節,中間是手臂+握把)
  jointLimit: 1.0,      // 武器臂關節可擺角度(±弧度)
  shieldLimit: 0.7,     // 盾臂關節可擺角度(±弧度,盾要穩)
  armStiffness: 3.0,    // 「肌肉」把手臂拉回正前方的彈簧勁度
  armDamping: 0.4,      // 肌肉彈簧的阻尼
  weaponDamping: 0.6,   // 手臂剛體本身的阻尼(低=甩起來很野)
  dmgThreshold: 4.5,    // 刃部接觸點相對速度低於這個只算「碰到」,不扣血
  dmgScale: 4.5,        // 傷害 = (相對速度 - 門檻) * 這個 * 武器倍率
  hitCooldown: 0.35,    // 同一把武器對同一人連續判傷的最短間隔(秒)
  maxHp: 250,
  arenaHalf: 5.5,       // 場地半寬
  aiSwingImpulse: 1.0,  // AI 揮武器的瞬間力道
  charHeight: 1.35,     // 角色模型縮放後的身高
};

// ---------- 裝備定義:模型 + 物理參數(商店系統的地基) ----------
type WeaponDef = {
  model: string;   // public/models/ 檔名
  length: number;  // 刃部長度(物理判定)
  density: number; // 密度:重武器慣性大、甩得慢
  dmgMult: number; // 傷害倍率:重武器打到更痛
};
type ShieldDef = {
  model: string;
  halfWidth: number; // 盾面半寬(物理)
  density: number;
};
const WEAPONS: Record<string, WeaponDef> = {
  sword2h: { model: 'sword_2handed', length: 1.6, density: 0.25, dmgMult: 1.0 },  // 大劍:長、快
  axe2h: { model: 'axe_2handed', length: 1.35, density: 0.5, dmgMult: 1.7 },      // 大斧:短、慢、痛
};
const SHIELDS: Record<string, ShieldDef> = {
  round: { model: 'shield_round', halfWidth: 0.46, density: 0.5 },
  spikes: { model: 'shield_spikes', halfWidth: 0.43, density: 0.65 },
};

const app = document.getElementById('app')!;
const msgEl = document.getElementById('msg')!;
const hpFillPlayer = document.querySelector<HTMLDivElement>('#hp-player .hpfill')!;
const hpFillEnemy = document.querySelector<HTMLDivElement>('#hp-enemy .hpfill')!;

// 2D 物理座標 (x, y) 對應 3D 場景 (x, 高度, -y)
function to3D(p: { x: number; y: number }, h = 0): THREE.Vector3 {
  return new THREE.Vector3(p.x, h, -p.y);
}
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
// 碰撞分組:自己的部件之間不互撞(武器不卡自己的盾),但照常撞敵人與牆
function partGroups(knightIndex: number): number {
  const membership = 1 << knightIndex;
  const filter = 0xffff & ~membership;
  return (membership << 16) | filter;
}
const WALL_GROUPS = (0x4 << 16) | 0xffff;

// ---------- 模型自動擺正 ----------
// 各模型軸向/原點不同,不逐件手調:量 bbox 自動轉正。
// 回傳的 group:內容沿 +X 從 0 延伸到 targetLen,Y/Z 置中。
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
// 盾:最薄軸轉到 +X(盾面法線朝敵人),最寬軸轉到 Z(橫向),全置中。
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
// 從角色模型抽出單一部件(bind pose 幾何),回傳未蒙皮的靜態 mesh
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

// ---------- 石板地貼圖(程式生成,不用外部素材) ----------
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
      // 石面斑點
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
  knight: GLTF;
  barbarian: GLTF;
};

async function boot() {
  await RAPIER.init();
  const loader = new GLTFLoader();
  const itemNames = ['sword_2handed', 'axe_2handed', 'shield_round', 'shield_spikes'];
  const [knight, barbarian, ...itemScenes] = await Promise.all([
    loader.loadAsync('/models/Knight.glb'),
    loader.loadAsync('/models/Barbarian.glb'),
    ...itemNames.map((n) => loader.loadAsync(`/models/${n}.gltf`).then((g) => {
      g.scene.traverse((o) => { o.castShadow = true; });
      return g.scene;
    })),
  ]);
  const items: Record<string, THREE.Object3D> = {};
  itemNames.forEach((n, i) => { items[n] = itemScenes[i]; });
  start({ items, knight, barbarian });
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

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 13, 5);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xccccff, 0x443f33, 0.85));
  const sun = new THREE.DirectionalLight(0xfff2e0, 1.3);
  sun.position.set(5, 12, 3);
  sun.castShadow = true;
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
  scene.add(sun);
  // 角落火把感的暖光
  for (const [lx, lz] of [[-CFG.arenaHalf, -CFG.arenaHalf], [CFG.arenaHalf, CFG.arenaHalf]] as const) {
    const torch = new THREE.PointLight(0xffaa55, 12, 14, 1.6);
    torch.position.set(lx, 2.2, lz);
    scene.add(torch);
  }

  const stoneTex = makeStoneTexture();
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.arenaHalf * 2 + 1, CFG.arenaHalf * 2 + 1),
    new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // ---------- Rapier 物理世界(俯視角 → 沒有重力) ----------
  const world = new RAPIER.World({ x: 0, y: 0 });

  // 四面牆(石材)
  const wallMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x8a8078, roughness: 0.9 });
  for (const [x, y, hx, hy] of [
    [0, CFG.arenaHalf, CFG.arenaHalf, 0.2],
    [0, -CFG.arenaHalf, CFG.arenaHalf, 0.2],
    [CFG.arenaHalf, 0, 0.2, CFG.arenaHalf],
    [-CFG.arenaHalf, 0, 0.2, CFG.arenaHalf],
  ] as const) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y));
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy).setCollisionGroups(WALL_GROUPS), body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.8, hy * 2), wallMat);
    mesh.position.set(x, 0.4, -y);
    mesh.castShadow = true;
    scene.add(mesh);
  }

  // 死亡碎裂用:部件 mesh 範本 + 它在身體上的局部位置(3D rig 座標)
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
    // AI 狀態
    swingTimer = 1.0;
    swingDir = 1;
    lastSwingAt = -9;
    stuckTime = 0;
    // step 前的速度快照:判傷要用「進入碰撞前」的速度
    weaponPreLv = { x: 0, y: 0 };
    weaponPreW = 0;
    bodyPreLv = { x: 0, y: 0 };

    constructor(x: number, y: number, angle: number, capeTint: number,
      public index: number, public isPlayer: boolean,
      char: GLTF, weaponKey: string, shieldKey: string) {
      this.spawn = { x, y, angle };
      this.weapon = WEAPONS[weaponKey];
      this.shield = SHIELDS[shieldKey];
      const groups = partGroups(index);

      // ----- 身體剛體 -----
      this.rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y)
          .setRotation(angle)
          .setLinearDamping(CFG.linearDamping)
          .setAngularDamping(CFG.angularDamping)
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(CFG.bodyRadius).setDensity(1.0).setRestitution(0.2)
          .setCollisionGroups(groups),
        this.rb
      );

      // ----- 兩隻手臂(武器在右手 = 2D 局部 -y,盾在左手 = +y) -----
      this.swordArm = this.makeArm({ x: 0.1, y: -CFG.shoulder }, CFG.jointLimit);
      this.shieldArm = this.makeArm({ x: 0.1, y: CFG.shoulder }, CFG.shieldLimit);

      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.2, 0.05).setTranslation(0.24, 0).setDensity(0.35)
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(this.weapon.length / 2, 0.04)
          .setTranslation(CFG.bladeStart + this.weapon.length / 2, 0)
          .setDensity(this.weapon.density)
          .setRestitution(0.3)
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.16, 0.05).setTranslation(0.2, 0).setDensity(0.35)
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.07, this.shield.halfWidth).setTranslation(0.48, 0)
          .setDensity(this.shield.density)
          .setRestitution(0.2)
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );

      // ----- 角色模型(KayKit,蒙皮+動畫) -----
      this.mesh = new THREE.Group();
      this.rig = new THREE.Group();
      this.mesh.add(this.rig);
      this.model = cloneSkeleton(char.scene);
      const bbox = new THREE.Box3().setFromObject(this.model);
      const charScale = CFG.charHeight / (bbox.max.y - bbox.min.y);
      this.model.scale.setScalar(charScale);
      const modelYaw = Math.PI / 2; // KayKit 面向 +Z → 遊戲面向 +X
      this.model.rotation.y = modelYaw;
      this.model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // 模型自帶的武器道具 + 手臂藏掉(手臂改掛在物理手臂上)
        if (/(Sword|Shield|Axe|Bow|Mug|Offhand|ArmLeft|ArmRight)/i.test(m.name)) {
          m.visible = false;
          return;
        }
        m.castShadow = true;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        if (/Cape$/.test(m.name)) mat.color.setHex(capeTint); // 披風染隊伍色
        m.material = mat;
        this.flashMats.push(mat);
      });
      this.rig.add(this.model);
      scene.add(this.mesh);

      // 死亡碎裂部件:身體/頭/頭盔/雙腿(bind pose 靜態化 + 置中修正)
      for (const suffix of [/Body$/, /Head$/, /(Helmet|Hat)$/, /LegLeft$/, /LegRight$/]) {
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
        this.debrisParts.push({ mesh: wrapper, l: { x: l.x, y: Math.max(0.15, l.y), z: l.z } });
      }

      // 動畫:走路/待機混合(手臂骨骼被藏掉,不衝突)
      this.mixer = new THREE.AnimationMixer(this.model);
      const walkClip = char.animations.find((a) => a.name === 'Walking_A');
      const idleClip = char.animations.find((a) => a.name === 'Idle');
      if (walkClip) { this.walkAction = this.mixer.clipAction(walkClip); this.walkAction.play(); }
      if (idleClip) { this.idleAction = this.mixer.clipAction(idleClip); this.idleAction.play(); }

      // ----- 物理手臂外觀:角色自己的手臂網格 + 武器/盾模型 -----
      const armRight = staticPart(char.scene, /ArmRight$/);
      const sg = this.swordArm.group;
      if (armRight) {
        const armFit = fitBlade(armRight, 0.5);
        armFit.position.set(0, 0.7, 0);
        armFit.traverse((o) => { o.castShadow = true; });
        sg.add(armFit);
      }
      const weaponModel = fitBlade(models.items[this.weapon.model], CFG.bladeStart + this.weapon.length - 0.25);
      weaponModel.position.set(0.25, 0.72, 0);
      sg.add(weaponModel);

      const armLeft = staticPart(char.scene, /ArmLeft$/);
      const hg = this.shieldArm.group;
      if (armLeft) {
        const armFit = fitBlade(armLeft, 0.45);
        armFit.position.set(0, 0.66, 0);
        armFit.traverse((o) => { o.castShadow = true; });
        hg.add(armFit);
      }
      const shieldModel = fitShield(models.items[this.shield.model], this.shield.halfWidth * 2 + 0.05);
      shieldModel.position.set(0.5, 0.62, 0);
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
      this.rb.applyTorqueImpulse(torque * dt, true);
    }

    reset() {
      this.hp = CFG.maxHp;
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

      // 走路/待機動畫依速度混合;傾身純視覺
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
  const player = new Knight(-3, 0, 0, 0x5588ff, 0, true, models.knight, 'sword2h', 'round');
  const enemy = new Knight(3, 0.8, Math.PI + 0.3, 0xff5544, 1, false, models.barbarian, 'axe2h', 'spikes');
  // 開 console 可以直接看血量/位置、改 CFG 調手感
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
      p.mesh.scale.setScalar(Math.min(1, p.age * 1.5) * 0.9);
    }
  }

  // ---------- 死亡碎裂:模型部件變殘骸,兩臂(手臂+武器)脫離飛走 ----------
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
      world.createCollider(RAPIER.ColliderDesc.ball(0.13).setDensity(0.4).setRestitution(0.4), rb);
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
    spawnBlood(to3D({ x: p.x, y: p.y }, 0.7), 40);
    spawnPool(to3D({ x: p.x, y: p.y }));
  }
  function updateDebris(dt: number) {
    for (const d of debris) {
      d.vy -= 9.8 * dt;
      d.h += d.vy * dt;
      if (d.h < 0.12 && d.vy < 0) {
        d.h = 0.12;
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
  // 每一幀直接算「刃部線段 vs 身體圓」,有交疊再看接觸點的相對速度夠不夠快。
  // 刃部長在武器臂剛體上;盾不造成傷害,純物理格擋。
  let gameOver = false;
  let clock = 0;
  const lastHitAt = new Map<string, number>();

  function updateHpBars() {
    hpFillPlayer.style.width = `${(player.hp / CFG.maxHp) * 100}%`;
    hpFillEnemy.style.width = `${(enemy.hp / CFG.maxHp) * 100}%`;
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
    if (Math.hypot(v.x - cx, v.y - cy) > CFG.bodyRadius + 0.12) return;

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
    spawnBlood(to3D({ x: cx, y: cy }, 0.8), Math.min(30, Math.round(dmg * 1.5)));
    updateHpBars();

    if (victim.hp <= 0) {
      gameOver = true;
      shatter(victim, impact);
      msgEl.textContent = victim.isPlayer ? '你被擊敗了 — 按 R 再來' : '你贏了!— 按 R 再來';
      msgEl.style.display = 'block';
    }
  }

  // ---------- 輸入 ----------
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow')) e.preventDefault();
    keys.add(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'r') restart();
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

  // ---------- 簡單 AI:瞄準 → 靠近 → 左右輪流甩武器 ----------
  function updateAI(dt: number) {
    const p = player.pos, e = enemy.pos;
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const targetAngle = Math.atan2(dy, dx);
    const diff = wrapAngle(targetAngle - enemy.angle);

    enemy.swingTimer -= dt;
    if (enemy.swingTimer <= 0 && dist < 2.8) {
      enemy.swingDir *= -1;
      enemy.rb.applyTorqueImpulse(enemy.swingDir * CFG.aiSwingImpulse, true);
      enemy.swingTimer = 1.1 + Math.random() * 0.8;
      enemy.lastSwingAt = clock;
    } else if (clock - enemy.lastSwingAt > 0.5) {
      const w = enemy.rb.angvel();
      enemy.turn(diff * 6 - w * 1.5, dt);
    }
    if (dist > 2.0 && Math.abs(diff) < 0.7) enemy.forward(CFG.moveForce, dt);
    else if (dist < 1.2) enemy.forward(-CFG.moveForce * 0.6, dt);

    const lv = enemy.rb.linvel();
    if (dist > 2.0 && Math.hypot(lv.x, lv.y) < 0.4) enemy.stuckTime += dt;
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

    if (!gameOver) {
      if (keys.has('arrowleft') || keys.has('a')) player.turn(CFG.turnTorque, dt);
      if (keys.has('arrowright') || keys.has('d')) player.turn(-CFG.turnTorque, dt);
      if (keys.has('arrowup') || keys.has('w')) player.forward(CFG.moveForce, dt);
      if (keys.has('arrowdown') || keys.has('s')) player.forward(-CFG.moveForce * 0.7, dt);
      updateAI(dt);
    }

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
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
