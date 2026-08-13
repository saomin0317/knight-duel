import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
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
  swordLength: 1.6,     // 劍刃長
  swordDensity: 0.25,   // 劍的密度:越重甩起來慣性越大
  bladeStart: 0.5,      // 劍刃起點(距離肩關節,中間是手臂+握把)
  jointLimit: 1.0,      // 劍臂關節可擺角度(±弧度)
  shieldLimit: 0.7,     // 盾臂關節可擺角度(±弧度,盾要穩)
  armStiffness: 3.0,    // 「肌肉」把手臂拉回正前方的彈簧勁度
  armDamping: 0.4,      // 肌肉彈簧的阻尼
  weaponDamping: 0.6,   // 手臂剛體本身的阻尼(低=甩起來很野)
  dmgThreshold: 4.5,    // 劍刃接觸點相對速度低於這個只算「碰到」,不扣血
  dmgScale: 4.5,        // 傷害 = (相對速度 - 門檻) * 這個
  hitCooldown: 0.35,    // 同一把劍對同一人連續判傷的最短間隔(秒)
  maxHp: 250,           // 鞭擊傷害變大後 100 血太快死
  arenaHalf: 5.5,       // 場地半寬
  aiSwingImpulse: 1.0,  // AI 揮劍的瞬間力道
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
// 碰撞分組:自己的部件之間不互撞(劍不卡自己的盾),但照常撞敵人與牆
// Rapier 規則:高 16 bit = 我是誰(membership),低 16 bit = 我撞誰(filter)
function partGroups(knightIndex: number): number {
  const membership = 1 << knightIndex;
  const filter = 0xffff & ~membership;
  return (membership << 16) | filter;
}
const WALL_GROUPS = (0x4 << 16) | 0xffff;

// ---------- 模型自動擺正 ----------
// KayKit 模型的軸向/原點各自不同,不逐件手調:量 bbox 自動轉正。
// 回傳的 group:內容沿 +X 從 0 延伸到 targetLen,Y/Z 置中。
function fitBlade(src: THREE.Object3D, targetLen: number): THREE.Group {
  const axisRot = new THREE.Group();
  axisRot.add(src.clone(true));
  let box = new THREE.Box3().setFromObject(axisRot);
  const size = box.getSize(new THREE.Vector3());
  if (size.y >= size.x && size.y >= size.z) axisRot.rotation.z = -Math.PI / 2;       // 最長軸 Y → X
  else if (size.z >= size.x && size.z >= size.y) axisRot.rotation.y = Math.PI / 2;   // 最長軸 Z → X
  const flip = new THREE.Group();
  flip.add(axisRot);
  box = new THREE.Box3().setFromObject(flip);
  if (Math.abs(box.min.x) > Math.abs(box.max.x)) flip.rotation.y = Math.PI;          // 刃尖朝 +X
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
  if (size.y <= size.x && size.y <= size.z) axisRot.rotation.z = Math.PI / 2;        // 最薄軸 Y → X
  else if (size.z <= size.x && size.z <= size.y) axisRot.rotation.y = Math.PI / 2;   // 最薄軸 Z → X
  const swap = new THREE.Group();
  swap.add(axisRot);
  box = new THREE.Box3().setFromObject(swap);
  size = box.getSize(new THREE.Vector3());
  if (size.y > size.z) swap.rotation.x = Math.PI / 2;                                // 寬邊轉到 Z
  const flip = new THREE.Group();
  flip.add(swap);
  box = new THREE.Box3().setFromObject(flip);
  if ((box.min.x + box.max.x) / 2 < 0) flip.rotation.y = Math.PI;                    // 盾心/尖刺朝 +X
  const outer = new THREE.Group();
  outer.add(flip);
  box = new THREE.Box3().setFromObject(outer);
  size = box.getSize(new THREE.Vector3());
  const scale = targetWidth / size.z;
  flip.position.set(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2);
  outer.scale.setScalar(scale);
  return outer;
}

type Models = { sword2h: THREE.Object3D; axe2h: THREE.Object3D; shieldRound: THREE.Object3D; shieldSpikes: THREE.Object3D };

async function boot() {
  await RAPIER.init();
  const loader = new GLTFLoader();
  const [sword2h, axe2h, shieldRound, shieldSpikes] = await Promise.all(
    ['sword_2handed', 'axe_2handed', 'shield_round', 'shield_spikes'].map((n) =>
      loader.loadAsync(`/models/${n}.gltf`).then((g) => {
        g.scene.traverse((o) => { o.castShadow = true; });
        return g.scene;
      })
    )
  );
  start({ sword2h, axe2h, shieldRound, shieldSpikes });
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
  scene.background = new THREE.Color(0x1a1a1f);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 13, 5); // 正上方偏一點點,比純垂直有立體感
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xccccff, 0x444422, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 12, 3);
  sun.castShadow = true;
  sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
  sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.arenaHalf * 2 + 1, CFG.arenaHalf * 2 + 1),
    new THREE.MeshStandardMaterial({ color: 0x3d3a35 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  scene.add(new THREE.GridHelper(CFG.arenaHalf * 2, 11, 0x555555, 0x2b2b2b));

  // ---------- Rapier 物理世界(俯視角 → 沒有重力) ----------
  const world = new RAPIER.World({ x: 0, y: 0 });

  // 四面牆
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30 });
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
    scene.add(mesh);
  }

  // ---------- 共用材質 ----------
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, metalness: 0.9, roughness: 0.25 });
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x4a3b2f, roughness: 0.9 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.7 });

  // 死亡碎裂用:部件 mesh + 它在身體上的局部位置
  type DebrisPart = { mesh: THREE.Mesh; l: { x: number; y: number; z: number } };

  // 一隻手臂 = 獨立剛體 + 肩關節 + 外觀 group
  type Arm = {
    rb: RAPIER.RigidBody;
    joint: RAPIER.ImpulseJoint | null;
    group: THREE.Group;
    anchor: { x: number; y: number }; // 肩關節在身體上的局部位置
    limit: number;
  };

  // ---------- 武士 ----------
  class Knight {
    rb: RAPIER.RigidBody;        // 身體
    swordArm: Arm;               // 右手:劍
    shieldArm: Arm;              // 左手:盾
    hp = CFG.maxHp;
    mesh: THREE.Group;           // 身體外觀
    rig: THREE.Group;            // 走路/傾身動畫層
    legL!: THREE.Mesh;
    legR!: THREE.Mesh;
    flashMats: THREE.MeshStandardMaterial[] = [];
    debrisParts: DebrisPart[] = [];
    walkPhase = 0;
    flashUntil = 0;
    spawn: { x: number; y: number; angle: number };
    // AI 狀態
    swingTimer = 1.0;
    swingDir = 1;
    lastSwingAt = -9;
    stuckTime = 0;
    // step 前的速度快照:撞擊瞬間解算器會把速度吸收掉,
    // 判傷要用「進入碰撞前」的速度才抓得到衝擊力
    weaponPreLv = { x: 0, y: 0 };
    weaponPreW = 0;
    bodyPreLv = { x: 0, y: 0 };

    constructor(x: number, y: number, angle: number, color: number,
      public index: number, public isPlayer: boolean,
      weaponModel: THREE.Object3D, shieldModel: THREE.Object3D) {
      this.spawn = { x, y, angle };
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

      const clothMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
      const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa0ad, metalness: 0.6, roughness: 0.5 });
      this.flashMats = [clothMat, steelMat];

      // ----- 兩隻手臂(劍在右手 = 2D 局部 -y,盾在左手 = +y) -----
      this.swordArm = this.makeArm({ x: 0.1, y: -CFG.shoulder }, CFG.jointLimit, groups);
      this.shieldArm = this.makeArm({ x: 0.1, y: CFG.shoulder }, CFG.shieldLimit, groups);

      // 劍臂碰撞體:手臂段 + 劍刃段
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.2, 0.05).setTranslation(0.24, 0).setDensity(0.35)
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(CFG.swordLength / 2, 0.04)
          .setTranslation(CFG.bladeStart + CFG.swordLength / 2, 0)
          .setDensity(CFG.swordDensity)
          .setRestitution(0.3)
          .setCollisionGroups(groups),
        this.swordArm.rb
      );
      // 盾臂碰撞體:手臂段 + 盾面(寬扁,擋東西用)
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.16, 0.05).setTranslation(0.2, 0).setDensity(0.35)
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.07, 0.42).setTranslation(0.48, 0).setDensity(0.5)
          .setRestitution(0.2)
          .setCollisionGroups(groups),
        this.shieldArm.rb
      );

      // ----- 身體外觀 -----
      this.mesh = new THREE.Group();
      this.rig = new THREE.Group();
      this.mesh.add(this.rig);

      const add = (m: THREE.Mesh, lx: number, ly: number, lz: number, asDebris = false) => {
        m.position.set(lx, ly, lz);
        m.castShadow = true;
        this.rig.add(m);
        if (asDebris) this.debrisParts.push({ mesh: m, l: { x: lx, y: ly, z: lz } });
        return m;
      };

      // 腿(局部座標:+X 是面向,+Z 是右手邊)
      this.legL = add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.14), leatherMat), 0, 0.15, -0.16, true);
      this.legR = add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.14), leatherMat), 0, 0.15, 0.16, true);
      // 戰袍(隊伍色)+ 胸甲
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.55, 14), clothMat), 0, 0.58, 0, true);
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.34, 0.25, 14), steelMat), 0, 0.82, 0, true);
      // 肩甲
      add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), steelMat), 0, 0.9, -0.34, true);
      add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), steelMat), 0, 0.9, 0.34, true);
      // 頭盔 + 面甲縫 + 盔纓(隊伍色)
      add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), steelMat), 0, 1.05, 0, true);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.2), darkMat), 0.14, 1.05, 0);
      add(new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.22, 0.06), clothMat), -0.04, 1.22, 0, true);
      scene.add(this.mesh);

      // ----- 劍臂外觀 -----
      const wadd = (g: THREE.Group, m: THREE.Mesh, lx: number, ly: number, lz: number) => {
        m.position.set(lx, ly, lz);
        m.castShadow = true;
        g.add(m);
        return m;
      };
      const sg = this.swordArm.group;
      wadd(sg, new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.1), clothMat), 0.15, 0.74, 0);
      wadd(sg, new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), leatherMat), 0.32, 0.73, 0);
      // 武器模型(KayKit):從握把 0.25 延伸到刃尖 ~2.15,涵蓋物理劍刃段 0.5~2.1
      const weapon = fitBlade(weaponModel, CFG.bladeStart + CFG.swordLength - 0.25);
      weapon.position.set(0.25, 0.72, 0);
      sg.add(weapon);
      // ----- 盾臂外觀:手臂 + 手 + 盾模型 -----
      const hg = this.shieldArm.group;
      wadd(hg, new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.1), clothMat), 0.14, 0.68, 0);
      wadd(hg, new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), leatherMat), 0.28, 0.67, 0);
      const shield = fitShield(shieldModel, 0.95);
      shield.position.set(0.5, 0.62, 0);
      hg.add(shield);
    }

    // 建一隻手臂:剛體 + 肩關節(限位 + 馬達彈簧當肌肉)
    makeArm(anchor: { x: number; y: number }, limit: number, groups: number): Arm {
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
      void groups; // 分組在呼叫端建碰撞體時設定
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
      // 手臂歸位 + 重接關節
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

      // 走路 + 傾身(純視覺,不影響物理)
      const lv = this.rb.linvel();
      const bw = this.rb.angvel();
      const speed = Math.hypot(lv.x, lv.y);
      this.walkPhase += (speed * 3 + Math.abs(bw) * 1.2) * dt;
      const amp = Math.min(0.14, speed * 0.06 + Math.abs(bw) * 0.01);
      this.legL.position.x = Math.sin(this.walkPhase) * amp;
      this.legR.position.x = -Math.sin(this.walkPhase) * amp;
      const a = this.angle;
      const fwdSpeed = lv.x * Math.cos(a) + lv.y * Math.sin(a);
      this.rig.rotation.x = THREE.MathUtils.clamp(fwdSpeed * 0.03, -0.12, 0.12);
      this.rig.rotation.z = THREE.MathUtils.clamp(-bw * 0.03, -0.15, 0.15);

      const flash = now < this.flashUntil ? 0x881111 : 0x000000;
      for (const m of this.flashMats) m.emissive.setHex(flash);
    }
  }

  // 出生點刻意不完全對稱:完全對稱會讓兩把劍「劍尖頂劍尖」形成穩定僵局
  const player = new Knight(-3, 0, 0, 0x4a90d9, 0, true, models.sword2h, models.shieldRound);
  const enemy = new Knight(3, 0.8, Math.PI + 0.3, 0xc0392b, 1, false, models.axe2h, models.shieldSpikes);
  // 開 console 可以直接看血量/位置、改 CFG 調手感
  (window as unknown as Record<string, unknown>).__game = { player, enemy, CFG };

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

  // ---------- 死亡碎裂:部件變成物理殘骸四散,兩隻手臂脫離飛走 ----------
  type Debris = {
    mesh: THREE.Mesh; rb: RAPIER.RigidBody;
    h: number; vy: number; spinAxis: THREE.Vector3; spin: number;
  };
  const debris: Debris[] = [];
  function shatter(k: Knight, impact: { x: number; y: number }) {
    k.rig.visible = false;
    const p = k.pos, a = k.angle;
    const mag = Math.hypot(impact.x, impact.y) || 1;
    const ix = impact.x / mag, iy = impact.y / mag;

    // 兩隻手臂脫離身體飛出去(關節斷開,剛體本來就存在)
    k.dropArms();
    for (const arm of [k.swordArm, k.shieldArm]) {
      arm.rb.applyImpulse({ x: ix * 0.12 + (Math.random() - 0.5) * 0.1, y: iy * 0.12 + (Math.random() - 0.5) * 0.1 }, true);
      arm.rb.applyTorqueImpulse((Math.random() - 0.5) * 1.2, true);
    }

    for (const part of k.debrisParts) {
      // 部件局部座標 → 2D 世界座標(局部 +X=面向, +Z=右手邊)
      const wx = p.x + part.l.x * Math.cos(a) + part.l.z * Math.sin(a);
      const wy = p.y + part.l.x * Math.sin(a) - part.l.z * Math.cos(a);
      const mesh = part.mesh.clone();
      mesh.position.set(wx, part.l.y, -wy);
      scene.add(mesh);
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(wx, wy)
          .setLinearDamping(2.5).setAngularDamping(3)
      );
      world.createCollider(RAPIER.ColliderDesc.ball(0.13).setDensity(0.4).setRestitution(0.4), rb);
      // 沿殺招方向噴飛 + 隨機散開
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
      // 水平位置跟物理走,高度用簡單拋物線(2D 物理沒有高度)
      d.vy -= 9.8 * dt;
      d.h += d.vy * dt;
      if (d.h < 0.1 && d.vy < 0) {
        d.h = 0.1;
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
  // 每一幀直接算「劍刃線段 vs 身體圓」,有交疊再看接觸點的相對速度夠不夠快。
  // 劍刃長在劍臂剛體上;盾不造成傷害,純物理格擋。
  let gameOver = false;
  let clock = 0;
  const lastHitAt = new Map<string, number>(); // "attacker->victim" → 時間

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
    const bx = wp.x + dirx * CFG.bladeStart, by = wp.y + diry * CFG.bladeStart; // 刃根

    // 受害者中心投影到劍刃線段,找最近點
    let t = (v.x - bx) * dirx + (v.y - by) * diry;
    t = Math.max(0, Math.min(CFG.swordLength, t));
    const cx = bx + dirx * t, cy = by + diry * t;
    if (Math.hypot(v.x - cx, v.y - cy) > CFG.bodyRadius + 0.12) return; // 沒碰到

    const key = attacker.isPlayer ? 'p->e' : 'e->p';
    if (clock - (lastHitAt.get(key) ?? -9) < CFG.hitCooldown) return;

    // 接觸點速度 = 武器平移速度 + 旋轉帶動(用 step 前快照)
    const lv = attacker.weaponPreLv, w = attacker.weaponPreW;
    const rx = cx - wp.x, ry = cy - wp.y;
    const vv = victim.bodyPreLv;
    const impact = { x: lv.x - w * ry - vv.x, y: lv.y + w * rx - vv.y };
    const relSpeed = Math.hypot(impact.x, impact.y);
    const dmg = Math.max(0, relSpeed - CFG.dmgThreshold) * CFG.dmgScale;
    if (dmg <= 0) return; // 慢慢碰到:不痛,物理引擎自己會推開

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

  // ---------- 簡單 AI:瞄準 → 靠近 → 左右輪流甩劍 ----------
  function updateAI(dt: number) {
    const p = player.pos, e = enemy.pos;
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const targetAngle = Math.atan2(dy, dx);
    const diff = wrapAngle(targetAngle - enemy.angle);

    enemy.swingTimer -= dt;
    if (enemy.swingTimer <= 0 && dist < 2.8) {
      // 出手:往一邊瞬間加力甩過去,下次換邊
      enemy.swingDir *= -1;
      enemy.rb.applyTorqueImpulse(enemy.swingDir * CFG.aiSwingImpulse, true);
      enemy.swingTimer = 1.1 + Math.random() * 0.8;
      enemy.lastSwingAt = clock;
    } else if (clock - enemy.lastSwingAt > 0.5) {
      // 揮完 0.5 秒內不瞄準讓劍甩完,其餘時間持續瞄準玩家(P 控制器 + 角速度阻尼)
      const w = enemy.rb.angvel();
      enemy.turn(diff * 6 - w * 1.5, dt);
    }
    if (dist > 2.0 && Math.abs(diff) < 0.7) enemy.forward(CFG.moveForce, dt);
    else if (dist < 1.2) enemy.forward(-CFG.moveForce * 0.6, dt);

    // 解僵局:想前進卻推不動(常見於劍尖頂劍尖對推)→往側面繞開
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
