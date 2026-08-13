import * as THREE from 'three';
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
  swordLength: 1.6,     // 劍長
  swordDensity: 0.25,   // 劍的密度:越重甩起來慣性越大
  dmgThreshold: 4.5,    // 劍身接觸點相對速度低於這個只算「碰到」,不扣血
  dmgScale: 4.5,        // 傷害 = (相對速度 - 門檻) * 這個
  hitCooldown: 0.35,    // 同一把劍對同一人連續判傷的最短間隔(秒)
  maxHp: 100,
  arenaHalf: 5.5,       // 場地半寬
  aiSwingImpulse: 0.8,  // AI 揮劍的瞬間力道
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

RAPIER.init().then(start);

function start() {
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
    world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy), body);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 0.8, hy * 2), wallMat);
    mesh.position.set(x, 0.4, -y);
    scene.add(mesh);
  }

  // ---------- 武士 ----------
  class Knight {
    rb: RAPIER.RigidBody;
    hp = CFG.maxHp;
    mesh: THREE.Group;
    bodyMat: THREE.MeshStandardMaterial;
    flashUntil = 0;
    spawn: { x: number; y: number; angle: number };
    // AI 狀態
    swingTimer = 1.0;
    swingDir = 1;
    lastSwingAt = -9;
    stuckTime = 0;
    // step 前的速度快照:撞擊瞬間解算器會把速度吸收掉,
    // 判傷要用「進入碰撞前」的速度才抓得到衝擊力
    preLv = { x: 0, y: 0 };
    preW = 0;

    constructor(x: number, y: number, angle: number, color: number, public isPlayer: boolean) {
      this.spawn = { x, y, angle };
      this.rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y)
          .setRotation(angle)
          .setLinearDamping(CFG.linearDamping)
          .setAngularDamping(CFG.angularDamping)
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(CFG.bodyRadius).setDensity(1.0).setRestitution(0.2),
        this.rb
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(CFG.swordLength / 2, 0.04)
          .setTranslation(CFG.bodyRadius + CFG.swordLength / 2, 0)
          .setDensity(CFG.swordDensity)
          .setRestitution(0.3),
        this.rb
      );

      // 灰盒外觀:圓柱身體 + 長方體劍 + 前方小塊標示臉的方向
      this.mesh = new THREE.Group();
      this.bodyMat = new THREE.MeshStandardMaterial({ color });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(CFG.bodyRadius, CFG.bodyRadius, 1.1, 20), this.bodyMat);
      body.position.y = 0.55;
      body.castShadow = true;
      this.mesh.add(body);
      const nose = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.2), this.bodyMat);
      nose.position.set(CFG.bodyRadius, 0.95, 0);
      this.mesh.add(nose);
      const sword = new THREE.Mesh(
        new THREE.BoxGeometry(CFG.swordLength, 0.1, 0.08),
        new THREE.MeshStandardMaterial({ color: 0xd0d0d8, metalness: 0.8, roughness: 0.3 })
      );
      sword.position.set(CFG.bodyRadius + CFG.swordLength / 2, 0.7, 0);
      sword.castShadow = true;
      this.mesh.add(sword);
      scene.add(this.mesh);
    }

    get pos() { return this.rb.translation(); }
    get angle() { return this.rb.rotation(); }

    captureVel() {
      const lv = this.rb.linvel();
      this.preLv = { x: lv.x, y: lv.y };
      this.preW = this.rb.angvel();
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
      this.swingTimer = 1.0;
      this.lastSwingAt = -9;
      this.stuckTime = 0;
    }

    sync(now: number) {
      const p = this.pos;
      this.mesh.position.set(p.x, 0, -p.y);
      this.mesh.rotation.y = this.angle;
      this.bodyMat.emissive.setHex(now < this.flashUntil ? 0x881111 : 0x000000);
    }
  }

  // 出生點刻意不完全對稱:完全對稱會讓兩把劍「劍尖頂劍尖」形成穩定僵局
  const player = new Knight(-3, 0, 0, 0x4a90d9, true);
  const enemy = new Knight(3, 0.8, Math.PI + 0.3, 0xc0392b, false);
  // 開 console 可以直接看血量/位置、改 CFG 調手感
  (window as unknown as Record<string, unknown>).__game = { player, enemy, CFG };

  // ---------- 噴血粒子(灰盒版:紅色小方塊) ----------
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

  // ---------- 傷害判定 ----------
  // 不用物理引擎的碰撞事件:兩人貼身時劍一直「接觸中」,揮劍不會產生新事件。
  // 改成每一幀直接算「劍身線段 vs 身體圓」,有交疊再看接觸點的相對速度夠不夠快。
  let gameOver = false;
  let clock = 0;
  const lastHitAt = new Map<string, number>(); // "attacker->victim" → 時間

  function swordHitCheck(attacker: Knight, victim: Knight) {
    if (gameOver) return;
    const a = attacker.angle, p = attacker.pos, v = victim.pos;
    const dirx = Math.cos(a), diry = Math.sin(a);
    const bx = p.x + dirx * CFG.bodyRadius, by = p.y + diry * CFG.bodyRadius; // 劍根

    // 受害者中心投影到劍身線段,找最近點
    let t = (v.x - bx) * dirx + (v.y - by) * diry;
    t = Math.max(0, Math.min(CFG.swordLength, t));
    const cx = bx + dirx * t, cy = by + diry * t;
    if (Math.hypot(v.x - cx, v.y - cy) > CFG.bodyRadius + 0.12) return; // 沒碰到

    const key = attacker.isPlayer ? 'p->e' : 'e->p';
    if (clock - (lastHitAt.get(key) ?? -9) < CFG.hitCooldown) return;

    // 接觸點速度 = 平移速度 + 旋轉帶動(離身體越遠甩越快)
    // 用 step 前的快照速度:撞擊當下解算器已把速度吃掉,事後讀是 0
    const lv = attacker.preLv, w = attacker.preW;
    const rx = cx - p.x, ry = cy - p.y;
    const vv = victim.preLv;
    const relSpeed = Math.hypot(lv.x - w * ry - vv.x, lv.y + w * rx - vv.y);
    const dmg = Math.max(0, relSpeed - CFG.dmgThreshold) * CFG.dmgScale;
    if (dmg <= 0) return; // 慢慢碰到:不痛,物理引擎自己會推開

    lastHitAt.set(key, clock);
    victim.hp = Math.max(0, victim.hp - dmg);
    victim.flashUntil = clock + 0.12;
    spawnBlood(to3D({ x: cx, y: cy }, 0.8), Math.min(30, Math.round(dmg * 1.5)));

    hpFillPlayer.style.width = `${player.hp}%`;
    hpFillEnemy.style.width = `${enemy.hp}%`;

    if (victim.hp <= 0) {
      gameOver = true;
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
    player.reset();
    enemy.reset();
    gameOver = false;
    msgEl.style.display = 'none';
    hpFillPlayer.style.width = '100%';
    hpFillEnemy.style.width = '100%';
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

    player.sync(clock);
    enemy.sync(clock);
    updateParticles(dt);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}
