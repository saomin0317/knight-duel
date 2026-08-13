import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import RAPIER from '@dimforge/rapier2d-compat';
import type { User } from 'firebase/auth';
import { loginGoogle, loginApple, loginAnon, logout, watchAuth, cloudLoad, cloudSave } from './account';

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
// 隱性相剋(刻意不在商店顯示,讓玩家自己發現):
//   shieldBreak 破盾:打中盾把盾撞開的力道——斧系高(破龜守)、杖系低(戳盾會滑開)
//   staminaMult 耗體:重武器揮舞更耗體力——重斧painful但容易力竭
//   thorns 反傷:尖刺盾被打到會刺傷攻擊者
type WeaponDef = { model: string; label: string; length: number; density: number; dmgMult: number; price: number; shieldBreak: number; staminaMult: number };
type ShieldDef = { model: string; label: string; halfWidth: number; density: number; price: number; thorns?: number };
const WEAPONS: Record<string, WeaponDef> = {
  sword1h: { model: 'sword_1handed', label: '短劍', length: 1.15 * S, density: 0.18 / (S * S), dmgMult: 0.8, price: 0, shieldBreak: 0.5, staminaMult: 0.85 },
  axe1h: { model: 'axe_1handed', label: '單手斧', length: 1.1 * S, density: 0.35 / (S * S), dmgMult: 1.3, price: 120, shieldBreak: 1.1, staminaMult: 1.1 },
  staff: { model: 'staff', label: '長木杖', length: 1.7 * S, density: 0.2 / (S * S), dmgMult: 0.85, price: 150, shieldBreak: 0.25, staminaMult: 0.9 },
  skelBlade: { model: 'Skeleton_Blade', label: '骷髏彎刀', length: 1.3 * S, density: 0.28 / (S * S), dmgMult: 1.1, price: 200, shieldBreak: 0.7, staminaMult: 0.95 },
  skelStaff: { model: 'Skeleton_Staff', label: '骨杖', length: 1.8 * S, density: 0.24 / (S * S), dmgMult: 0.95, price: 240, shieldBreak: 0.3, staminaMult: 0.95 },
  sword2h: { model: 'sword_2handed', label: '雙手大劍', length: 1.6 * S, density: 0.25 / (S * S), dmgMult: 1.0, price: 260, shieldBreak: 0.8, staminaMult: 1.0 },
  skelAxe: { model: 'Skeleton_Axe', label: '骷髏斧', length: 1.25 * S, density: 0.42 / (S * S), dmgMult: 1.5, price: 300, shieldBreak: 1.4, staminaMult: 1.25 },
  axe2h: { model: 'axe_2handed', label: '雙手大斧', length: 1.35 * S, density: 0.5 / (S * S), dmgMult: 1.7, price: 380, shieldBreak: 1.7, staminaMult: 1.35 },
};
const SHIELDS: Record<string, ShieldDef> = {
  badge: { model: 'shield_badge', label: '徽章小盾', halfWidth: 0.34 * S, density: 0.4 / (S * S), price: 0 },
  skelSmallA: { model: 'Skeleton_Shield_Small_A', label: '骨片小盾', halfWidth: 0.36 * S, density: 0.45 / (S * S), price: 80 },
  skelSmallB: { model: 'Skeleton_Shield_Small_B', label: '裂骨小盾', halfWidth: 0.38 * S, density: 0.42 / (S * S), price: 90 },
  round: { model: 'shield_round', label: '圓盾', halfWidth: 0.46 * S, density: 0.5 / (S * S), price: 120 },
  square: { model: 'shield_square', label: '方盾', halfWidth: 0.42 * S, density: 0.55 / (S * S), price: 160 },
  skelLargeA: { model: 'Skeleton_Shield_Large_A', label: '骨牆大盾', halfWidth: 0.48 * S, density: 0.6 / (S * S), price: 200 },
  skelLargeB: { model: 'Skeleton_Shield_Large_B', label: '骸骨大盾', halfWidth: 0.5 * S, density: 0.58 / (S * S), price: 220 },
  spikes: { model: 'shield_spikes', label: '尖刺盾', halfWidth: 0.43 * S, density: 0.65 / (S * S), price: 240, thorns: 9 },
};

// ---------- AI 個性:六種進攻策略 ----------
type AiStyle = 'brawler' | 'guardian' | 'kiter' | 'assassin' | 'berserker' | 'spinner';
type AiParams = {
  engage: number;      // 接近到這個距離(×S)就停
  retreatAt: number;   // 近於這個(×S)就後退
  swingAt: number;     // 出手距離(×S)
  swingRate: number;   // 出手頻率倍率
  spinMargin: number;  // 對手旋轉時的額外安全邊
  aimLead: number;     // 瞄準偏角(guardian 讓盾側領前)
  strafe: number;      // 側向遊走強度
  counterOnly?: boolean; // 只在對手體力低或貼臉才出手
  kite?: boolean;        // 維持自己武器射程放風箏
  ambush?: boolean;      // 等對手刀口朝外才出手
  berserk?: boolean;     // 血越低越兇
  spinner?: boolean;     // 用旋轉蓄力打法
};
const AI_STYLES: Record<AiStyle, AiParams> = {
  brawler: { engage: 1.7, retreatAt: 0.9, swingAt: 2.9, swingRate: 1.2, spinMargin: 0.3, aimLead: 0, strafe: 0 },
  guardian: { engage: 1.9, retreatAt: 1.1, swingAt: 2.5, swingRate: 0.75, spinMargin: 0.7, aimLead: 0.4, strafe: 0, counterOnly: true },
  kiter: { engage: 2.6, retreatAt: 2.0, swingAt: 3.4, swingRate: 1.0, spinMargin: 0.8, aimLead: 0, strafe: 0.6, kite: true },
  assassin: { engage: 2.0, retreatAt: 1.2, swingAt: 2.8, swingRate: 1.1, spinMargin: 0.6, aimLead: 0, strafe: 1.0, ambush: true },
  berserker: { engage: 1.6, retreatAt: 0.7, swingAt: 3.0, swingRate: 1.15, spinMargin: 0.2, aimLead: 0, strafe: 0, berserk: true },
  spinner: { engage: 2.4, retreatAt: 1.4, swingAt: 3.0, swingRate: 1.0, spinMargin: 0.6, aimLead: 0, strafe: 0, spinner: true },
};

// ---------- 敵人階梯:12 關,個性/配裝/體型/賞金遞增(後段=重混精英) ----------
type Foe = {
  char: string; label: string; weapon: string; shield: string; tint: number;
  hpMult: number; moveMult: number; swingMult: number; heightMult: number; reward: number;
  style: AiStyle;
};
const ENEMY_ROSTER: Foe[] = [
  { char: 'skelMinion', label: '骷髏小兵', weapon: 'skelBlade', shield: 'skelSmallA', tint: 0x88ff88, hpMult: 0.7, moveMult: 0.85, swingMult: 0.8, heightMult: 0.85, reward: 40, style: 'brawler' },
  { char: 'rogue', label: '盜賊', weapon: 'sword1h', shield: 'badge', tint: 0xdd4466, hpMult: 0.9, moveMult: 1.1, swingMult: 0.9, heightMult: 1.0, reward: 60, style: 'assassin' },
  { char: 'skelRogue', label: '骷髏遊蕩者', weapon: 'skelBlade', shield: 'skelSmallB', tint: 0x66dd66, hpMult: 1.1, moveMult: 1.15, swingMult: 1.0, heightMult: 0.95, reward: 85, style: 'brawler' },
  { char: 'rogueHooded', label: '刺客', weapon: 'axe1h', shield: 'square', tint: 0x995544, hpMult: 1.3, moveMult: 1.2, swingMult: 1.05, heightMult: 1.0, reward: 115, style: 'assassin' },
  { char: 'skelMage', label: '骷髏法師', weapon: 'skelStaff', shield: 'skelSmallB', tint: 0x55ccbb, hpMult: 1.5, moveMult: 1.0, swingMult: 1.1, heightMult: 1.0, reward: 150, style: 'kiter' },
  { char: 'barbarian', label: '野蠻人', weapon: 'axe2h', shield: 'spikes', tint: 0xff5544, hpMult: 1.8, moveMult: 1.0, swingMult: 1.15, heightMult: 1.05, reward: 190, style: 'berserker' },
  { char: 'mage', label: '法師', weapon: 'staff', shield: 'round', tint: 0xcc55cc, hpMult: 2.1, moveMult: 1.05, swingMult: 1.25, heightMult: 1.0, reward: 240, style: 'kiter' },
  { char: 'skelWarrior', label: '骷髏戰士', weapon: 'skelAxe', shield: 'skelLargeA', tint: 0x44ff99, hpMult: 2.5, moveMult: 1.05, swingMult: 1.3, heightMult: 1.08, reward: 300, style: 'guardian' },
  { char: 'rogueHooded', label: '影武者', weapon: 'sword2h', shield: 'badge', tint: 0x333344, hpMult: 1.9, moveMult: 1.1, swingMult: 1.2, heightMult: 1.0, reward: 360, style: 'spinner' },
  { char: 'barbarian', label: '蠻王', weapon: 'axe2h', shield: 'skelLargeB', tint: 0x882211, hpMult: 2.4, moveMult: 1.15, swingMult: 1.3, heightMult: 1.15, reward: 430, style: 'berserker' },
  { char: 'mage', label: '大法師', weapon: 'skelStaff', shield: 'round', tint: 0x7722aa, hpMult: 2.6, moveMult: 1.1, swingMult: 1.4, heightMult: 1.05, reward: 500, style: 'kiter' },
  { char: 'skelWarrior', label: '骷髏王', weapon: 'skelAxe', shield: 'spikes', tint: 0xffcc33, hpMult: 3.0, moveMult: 1.1, swingMult: 1.45, heightMult: 1.15, reward: 600, style: 'guardian' },
];

// ---------- 存檔:金幣 / 擁有 / 裝備中 / 戰績 ----------
type Save = { gold: number; ownedW: string[]; ownedS: string[]; eqW: string; eqS: string; wins: number; losses: number; maxLevel: number };
// 統一正規化:欄位順序固定,雲端/本地存檔比對才不會因缺欄位或順序而誤判不同
function normalizeSave(raw: unknown): Save {
  const def: Save = { gold: 0, ownedW: ['sword1h'], ownedS: ['badge'], eqW: 'sword1h', eqS: 'badge', wins: 0, losses: 0, maxLevel: 0 };
  if (!raw || typeof raw !== 'object') return def;
  const s = raw as Partial<Save>;
  return {
    gold: Math.max(0, Number(s.gold) || 0),
    ownedW: Array.isArray(s.ownedW) && s.ownedW.length ? s.ownedW.filter((k) => WEAPONS[k]) : def.ownedW,
    ownedS: Array.isArray(s.ownedS) && s.ownedS.length ? s.ownedS.filter((k) => SHIELDS[k]) : def.ownedS,
    eqW: s.eqW && WEAPONS[s.eqW] ? s.eqW : def.eqW,
    eqS: s.eqS && SHIELDS[s.eqS] ? s.eqS : def.eqS,
    wins: Math.max(0, Number(s.wins) || 0),
    losses: Math.max(0, Number(s.losses) || 0),
    maxLevel: Math.min(Math.max(0, Number(s.maxLevel) || 0), ENEMY_ROSTER.length - 1),
  };
}
function loadSave(): Save {
  try { return normalizeSave(JSON.parse(localStorage.getItem('kd_save') ?? '')); }
  catch { return normalizeSave(null); }
}
const SAVE = loadSave();

// 雲端同步:登入後每次存檔變動,延遲 1.5 秒推上雲(合併連續變動)
let currentUser: User | null = null;
let cloudPushTimer: number | undefined;
function scheduleCloudPush() {
  if (!currentUser) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = window.setTimeout(() => {
    if (currentUser) cloudSave(currentUser, SAVE).catch(() => { /* 離線不擋遊戲 */ });
  }, 1500);
}
function persistSave() {
  localStorage.setItem('kd_save', JSON.stringify(SAVE));
  scheduleCloudPush();
}
// 會觸發 reload 的變更(換裝/過關)必須「先推上雲再 reload」——
// debounce 推送會被 reload 殺掉,reload 回來雲端舊檔就把變更蓋掉了
async function reloadWithCloudSync(setup: () => void) {
  setup();
  clearTimeout(cloudPushTimer);
  try { if (currentUser) await cloudSave(currentUser, SAVE); } catch { /* 離線就只靠本機 */ }
  location.reload();
}

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
// ---------- 音效(Kenney CC0):同類多檔隨機 + 音高抖動,避免機關槍感 ----------
const SFX_FILES: Record<string, string[]> = {
  clang: ['impactMetal_medium_000', 'impactMetal_medium_001', 'impactMetal_medium_002', 'impactMetal_medium_003', 'impactMetal_medium_004'],
  clangHeavy: ['impactMetal_heavy_000', 'impactMetal_heavy_001'],
  flesh: ['impactPunch_medium_000', 'impactPunch_medium_001'],
  fleshHeavy: ['impactPunch_heavy_000'],
  chop: ['chop'],
  coins: ['handleCoins', 'handleCoins2'],
  click: ['metalClick'],
};
let audioCtx: AudioContext | null = null;
let sfxMuted = localStorage.getItem('kd_muted') === '1';
const sfxBuffers = new Map<string, AudioBuffer[]>();
async function initAudio() {
  if (audioCtx) return;
  audioCtx = new AudioContext();
  await Promise.all(Object.entries(SFX_FILES).map(async ([key, names]) => {
    const bufs = await Promise.all(names.map(async (n) => {
      const res = await fetch(`sfx/${n}.ogg`);
      return audioCtx!.decodeAudioData(await res.arrayBuffer());
    }));
    sfxBuffers.set(key, bufs);
  }));
}
function playSfx(key: string, volume = 1, rate = 1) {
  if (sfxMuted || !audioCtx) return;
  const bufs = sfxBuffers.get(key);
  if (!bufs?.length) return;
  const src = audioCtx.createBufferSource();
  src.buffer = bufs[(Math.random() * bufs.length) | 0];
  src.playbackRate.value = rate * (0.92 + Math.random() * 0.16);
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(audioCtx.destination);
  src.start();
}

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
// 場景道具擺正:縮放到目標高度,底部貼地,水平置中
function fitProp(src: THREE.Object3D, targetH: number): THREE.Group {
  const obj = src.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const g = new THREE.Group();
  g.add(obj);
  obj.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  g.scale.setScalar(targetH / (box.max.y - box.min.y));
  return g;
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
  try {
    await bootInner();
    document.getElementById('loading')!.style.display = 'none';
  } catch (e) {
    document.querySelector('#loading .ld-text')!.textContent = '載入失敗,請重新整理再試';
    throw e;
  }
}
// 場景道具(KayKit Dungeon Remastered=.glb 內嵌貼圖;Halloween Bits=.gltf 外連貼圖)
const PROP_FILES: Record<string, string> = {
  barrel_large: 'barrel_large.glb', barrel_small_stack: 'barrel_small_stack.glb',
  box_large: 'box_large.glb', crates_stacked: 'crates_stacked.glb',
  pillar: 'pillar.glb', column: 'column.glb', torch_lit: 'torch_lit.glb',
  skull: 'skull.gltf', bone_A: 'bone_A.gltf', ribcage: 'ribcage.gltf',
};

async function bootInner() {
  await RAPIER.init();
  const loader = new GLTFLoader();
  // 武器/盾/道具模型都小,全載;角色 GLB 一隻 ~4MB,只載本場要用的兩隻
  const itemNames = [...new Set([
    ...Object.values(WEAPONS).map((w) => w.model),
    ...Object.values(SHIELDS).map((s) => s.model),
  ])];
  // 關卡制:只能打到已解鎖的最高關
  const foeIdx = Math.min((parseInt(localStorage.getItem('enemyIdx') ?? '0', 10) || 0), SAVE.maxLevel);
  const charKeys = [...new Set(['knight', ENEMY_ROSTER[foeIdx].char])];
  const propKeys = Object.keys(PROP_FILES);
  const loaded = await Promise.all([
    ...charKeys.map((k) => loader.loadAsync(`models/${CHAR_FILES[k]}`)),
    ...itemNames.map((n) => loader.loadAsync(`models/${n}.gltf`).then((g) => {
      g.scene.traverse((o) => { o.castShadow = true; });
      return g.scene;
    })),
    ...propKeys.map((k) => loader.loadAsync(`models/${PROP_FILES[k]}`).then((g) => g.scene)),
  ]);
  const chars: Record<string, GLTF> = {};
  charKeys.forEach((k, i) => { chars[k] = loaded[i] as GLTF; });
  const items: Record<string, THREE.Object3D> = {};
  itemNames.forEach((n, i) => { items[n] = loaded[charKeys.length + i] as THREE.Object3D; });
  propKeys.forEach((k, i) => { items[k] = loaded[charKeys.length + itemNames.length + i] as THREE.Object3D; });
  start({ items, chars });
}
boot();

function start(models: Models) {
  // ---------- Three.js 場景 ----------
  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2)); // 手機壓像素比保 60fps
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
  // 火把暖光(位置由 buildArena 吸附到火把道具上)
  const torchLights: THREE.PointLight[] = [];
  for (const [lx, lz] of [[-2.8, -2.8], [2.8, 2.8]] as const) {
    const torch = new THREE.PointLight(0xffaa55, 12, 14, 1.6);
    torch.position.set(lx, 2.2, lz);
    scene.add(torch);
    torchLights.push(torch);
  }

  const stoneTex = makeStoneTexture();
  const floorMat = new THREE.MeshStandardMaterial({ map: stoneTex, roughness: 0.95 });
  const wallMat = new THREE.MeshStandardMaterial({ map: stoneTex, color: 0x8a8078, roughness: 0.9 });

  // ---------- Rapier 物理世界(俯視角 → 沒有重力) ----------
  const world = new RAPIER.World({ x: 0, y: 0 });
  // 碰撞事件只拿來觸發音效(金屬碰撞聲);判傷仍是幾何判定
  const eventQueue = new RAPIER.EventQueue(true);
  const armColHandles = new Set<number>();
  const wallColHandles = new Set<number>();
  // 碰撞體細分:破盾/反傷判定要知道打到的是刃還是盾面
  type ColKind = 'arm' | 'blade' | 'shield';
  const colInfo = new Map<number, { knight: Knight; kind: ColKind }>();

  // ---------- 場地產生器:N 邊形圍牆(圓=40邊) ----------
  const arenaObjs: { bodies: RAPIER.RigidBody[]; meshes: THREE.Object3D[] } = { bodies: [], meshes: [] };
  // 場地隨機,不開放選擇
  const randomShape = () => {
    const keys = Object.keys(ARENA_SHAPES);
    return keys[Math.floor(Math.random() * keys.length)];
  };
  let arenaShape = randomShape();

  function buildArena(key: string) {
    for (const b of arenaObjs.bodies) world.removeRigidBody(b);
    for (const m of arenaObjs.meshes) scene.remove(m);
    arenaObjs.bodies.length = 0;
    arenaObjs.meshes.length = 0;
    wallColHandles.clear();
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
      const wc = world.createCollider(RAPIER.ColliderDesc.cuboid(halfLen + 0.05, 0.2).setCollisionGroups(WALL_GROUPS), body);
      wallColHandles.add(wc.handle);
      arenaObjs.bodies.push(body);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(halfLen * 2 + 0.1, 0.9, 0.4), wallMat);
      mesh.position.set(cx, 0.45, -cy);
      mesh.rotation.y = rot;
      mesh.castShadow = true;
      scene.add(mesh);
      arenaObjs.meshes.push(mesh);
    }

    // ----- 場地裝飾(純視覺):火把圍場 + 白骨點綴,鬥技場氛圍 -----
    const torchCount = 6;
    for (let i = 0; i < torchCount; i++) {
      const phi = offset + (i + 0.5) * (Math.PI * 2) / torchCount;
      const tx = Math.cos(phi) * (apothem - 0.45), ty = Math.sin(phi) * (apothem - 0.45);
      const torch = fitProp(models.items.torch_lit, 1.15);
      torch.position.set(tx, 0, -ty);
      scene.add(torch);
      arenaObjs.meshes.push(torch);
      if (i === 0) torchLights[0].position.set(tx, 1.7, -ty);
      if (i === 3) torchLights[1].position.set(tx, 1.7, -ty);
    }
    const boneKeys = ['skull', 'bone_A', 'ribcage'];
    for (let i = 0; i < 6; i++) {
      const phi = Math.random() * Math.PI * 2;
      const rr = apothem - 0.5 - Math.random() * 0.7;
      const b = fitProp(models.items[boneKeys[i % boneKeys.length]], 0.2 + Math.random() * 0.14);
      b.position.set(Math.cos(phi) * rr, 0.01, -Math.sin(phi) * rr);
      b.rotation.y = Math.random() * Math.PI * 2;
      scene.add(b);
      arenaObjs.meshes.push(b);
    }
  }

  // ----- 障礙物(有物理):桶/箱/柱,後面的關卡才出現 -----
  const OBSTACLE_DEFS = [
    { model: 'barrel_large', r: 0.5, h: 1.0 },
    { model: 'barrel_small_stack', r: 0.55, h: 1.15 },
    { model: 'box_large', r: 0.55, h: 1.0 },
    { model: 'crates_stacked', r: 0.6, h: 1.5 },
    { model: 'pillar', r: 0.5, h: 2.2 },
    { model: 'column', r: 0.45, h: 2.3 },
  ];
  const obstacleObjs: { bodies: RAPIER.RigidBody[]; meshes: THREE.Object3D[] } = { bodies: [], meshes: [] };
  function obstacleCountFor(levelIdx: number): number {
    if (levelIdx <= 3) return 0;             // 前四關乾淨場地
    if (levelIdx <= 7) return 2 + (levelIdx % 2);
    return 4 + (levelIdx % 2);
  }
  function buildObstacles(count: number) {
    for (const b of obstacleObjs.bodies) world.removeRigidBody(b);
    for (const m of obstacleObjs.meshes) scene.remove(m);
    obstacleObjs.bodies.length = 0;
    obstacleObjs.meshes.length = 0;
    const { n, r: R } = ARENA_SHAPES[arenaShape];
    const apothem = R * Math.cos(Math.PI / n);
    const placed: { x: number; y: number }[] = [];
    const spawns = [{ x: -2.6, y: 0 }, { x: 2.6, y: 0.8 }];
    for (let i = 0; i < count; i++) {
      const def = OBSTACLE_DEFS[Math.floor(Math.random() * OBSTACLE_DEFS.length)];
      let px = 0, py = 0, ok = false;
      for (let t = 0; t < 40 && !ok; t++) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() * (apothem - 1.6);
        px = Math.cos(a) * rr; py = Math.sin(a) * rr;
        ok = spawns.every((s) => Math.hypot(px - s.x, py - s.y) > 2.0)
          && placed.every((q) => Math.hypot(px - q.x, py - q.y) > 1.6);
      }
      if (!ok) continue;
      placed.push({ x: px, y: py });
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(px, py));
      const col = world.createCollider(RAPIER.ColliderDesc.ball(def.r).setCollisionGroups(WALL_GROUPS), body);
      wallColHandles.add(col.handle); // 撞到有金屬/悶擊聲
      obstacleObjs.bodies.push(body);
      const mesh = fitProp(models.items[def.model], def.h);
      mesh.position.set(px, 0, -py);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      mesh.traverse((o) => { o.castShadow = true; });
      scene.add(mesh);
      obstacleObjs.meshes.push(mesh);
    }
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
    cheerAction: THREE.AnimationAction | null = null;
    celebrating = false;
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
    aiStyle: AiStyle;
    stamina = CFG.staminaMax;
    exhausted = false;

    constructor(x: number, y: number, angle: number, capeTint: number,
      public index: number, public isPlayer: boolean,
      char: GLTF, weaponKey: string, shieldKey: string,
      stats?: { hpMult?: number; moveMult?: number; swingMult?: number; heightMult?: number; style?: AiStyle }) {
      this.spawn = { x, y, angle };
      this.weapon = WEAPONS[weaponKey];
      this.shield = SHIELDS[shieldKey];
      this.maxHp = CFG.maxHp * (stats?.hpMult ?? 1);
      this.hp = this.maxHp;
      this.moveMult = stats?.moveMult ?? 1;
      this.swingMult = stats?.swingMult ?? 1;
      this.aiStyle = stats?.style ?? 'brawler';
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

      const armCols = [
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.2 * S, 0.05 * S).setTranslation(0.24 * S, 0).setDensity(0.35 / (S * S))
            .setCollisionGroups(groups).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          this.swordArm.rb
        ),
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(this.weapon.length / 2, 0.04 * S)
            .setTranslation(CFG.bladeStart + this.weapon.length / 2, 0)
            .setDensity(this.weapon.density)
            .setRestitution(0.3)
            .setCollisionGroups(groups).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          this.swordArm.rb
        ),
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.16 * S, 0.05 * S).setTranslation(0.2 * S, 0).setDensity(0.35 / (S * S))
            .setCollisionGroups(groups).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          this.shieldArm.rb
        ),
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(0.07 * S, this.shield.halfWidth).setTranslation(0.48 * S, 0)
            .setDensity(this.shield.density)
            .setRestitution(0.2)
            .setCollisionGroups(groups).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
          this.shieldArm.rb
        ),
      ];
      for (const c of armCols) armColHandles.add(c.handle);
      const kinds: ColKind[] = ['arm', 'blade', 'arm', 'shield'];
      armCols.forEach((c, i) => colInfo.set(c.handle, { knight: this, kind: kinds[i] }));

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
      const cheerClip = char.animations.find((a) => a.name === 'Cheer');
      if (walkClip) { this.walkAction = this.mixer.clipAction(walkClip); this.walkAction.play(); }
      if (idleClip) { this.idleAction = this.mixer.clipAction(idleClip); this.idleAction.play(); }
      if (cheerClip) this.cheerAction = this.mixer.clipAction(cheerClip);

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

    // 中途斷肢:單臂脫離 + 噴血 + 小血泊(手臂+武器變殘骸自然飛走)
    severArm(arm: Arm, ix: number, iy: number) {
      if (!arm.joint) return;
      world.removeImpulseJoint(arm.joint, true);
      arm.joint = null;
      arm.rb.applyImpulse({ x: ix * 0.1 + (Math.random() - 0.5) * 0.06, y: iy * 0.1 + (Math.random() - 0.5) * 0.06 }, true);
      arm.rb.applyTorqueImpulse((Math.random() - 0.5) * 1.0, true);
      const sp = arm.rb.translation();
      spawnBlood(to3D({ x: sp.x, y: sp.y }, 0.9 * S), 24);
      spawnPool(to3D({ x: sp.x, y: sp.y }), 0.45);
      playSfx('chop', 0.9);
    }

    // 勝利歡呼
    victoryPose() {
      this.celebrating = true;
      if (this.cheerAction) {
        this.cheerAction.reset();
        this.cheerAction.setEffectiveWeight(1);
        this.cheerAction.play();
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
    // 重武器耗體更兇(staminaMult):大斧痛但容易力竭,輕劍打持久戰
    updateStamina(dt: number) {
      const w = this.rb.angvel();
      const aw = Math.abs(w);
      if (aw > CFG.spinThreshold) this.stamina -= (aw - CFG.spinThreshold) * CFG.staminaDrain * this.weapon.staminaMult * dt;
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
      this.celebrating = false;
      this.cheerAction?.stop();
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
      if (this.celebrating) {
        this.walkAction?.setEffectiveWeight(0);
        this.idleAction?.setEffectiveWeight(0);
      } else {
        if (this.walkAction) {
          this.walkAction.setEffectiveWeight(w);
          this.walkAction.timeScale = 0.5 + speed * 0.45;
        }
        if (this.idleAction) this.idleAction.setEffectiveWeight(1 - w);
      }
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
  // 與 boot 端同一套鉗制:只能打到已解鎖的最高關(兩邊不一致會載錯角色模型)
  const enemyIdx = Math.min((parseInt(localStorage.getItem('enemyIdx') ?? '0', 10) || 0), SAVE.maxLevel);
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
      html += `<div class="srow"><img class="thumb" src="${thumbOf(w.model)}"><span class="sname">${w.label}</span>
        <span class="sstat">長 ${w.length.toFixed(1)}|${weightLabel(w.density)}|威力 x${w.dmgMult}</span>
        <button data-t="w" data-k="${k}" class="${eq ? 'eq' : cant ? 'cant' : ''}">${eq ? '裝備中' : owned ? '裝備' : `${w.price} 金`}</button></div>`;
    }
    html += '<h3>盾牌</h3>';
    for (const [k, s] of Object.entries(SHIELDS)) {
      const owned = SAVE.ownedS.includes(k);
      const eq = SAVE.eqS === k;
      const cant = !owned && SAVE.gold < s.price;
      html += `<div class="srow"><img class="thumb" src="${thumbOf(s.model)}"><span class="sname">${s.label}</span>
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
          playSfx('coins', 0.8);
        } else if ((isW ? SAVE.eqW : SAVE.eqS) !== k) {
          if (isW) SAVE.eqW = k; else SAVE.eqS = k;
          persistSave();
          // 裝備綁在建構期(碰撞體+模型),重載最乾淨;先推雲防止舊檔蓋回來
          void reloadWithCloudSync(() => localStorage.setItem('kd_mode', 'menu'));
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

  // ---------- 裝備縮圖:離屏渲染模型生成,不用外部圖 ----------
  let thumbRenderer: THREE.WebGLRenderer | null = null;
  const thumbCache = new Map<string, string>();
  function thumbOf(name: string): string {
    const cached = thumbCache.get(name);
    if (cached) return cached;
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      thumbRenderer.setSize(96, 96);
    }
    const sc = new THREE.Scene();
    sc.add(new THREE.HemisphereLight(0xffffff, 0x555544, 1.5));
    const dl = new THREE.DirectionalLight(0xffffff, 1.8);
    dl.position.set(2, 3, 2);
    sc.add(dl);
    const obj = models.items[name].clone(true);
    const box = new THREE.Box3().setFromObject(obj);
    obj.position.sub(box.getCenter(new THREE.Vector3()));
    sc.add(obj);
    const span = box.getSize(new THREE.Vector3()).length();
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 50);
    const d = span * 0.85 + 0.15;
    cam.position.set(d, d * 0.65, d);
    cam.lookAt(0, 0, 0);
    thumbRenderer.render(sc, cam);
    const url = thumbRenderer.domElement.toDataURL();
    thumbCache.set(name, url);
    return url;
  }

  // ---------- 主畫面 / 戰鬥 模式切換 ----------
  const menuEl = document.getElementById('menu')!;
  const battleBtnsEl = document.getElementById('battle-btns')!;
  const oppLabelEl = document.getElementById('opp-label')!;
  // attract = 開場畫面背後的 AI 對 AI 循環表演賽
  let mode: 'menu' | 'battle' | 'attract' = localStorage.getItem('kd_mode') === 'battle' ? 'battle' : 'menu';
  if (!sessionStorage.getItem('kd_title_seen')) mode = 'attract';
  let menuTimer: number | undefined;

  function setEnemyVisible(v: boolean) {
    enemy.mesh.visible = v;
    enemy.swordArm.group.visible = v;
    enemy.shieldArm.group.visible = v;
  }
  function updateMenuUI() {
    oppLabelEl.textContent = `第 ${enemyIdx + 1} 關|${foe.label}|血量 x${foe.hpMult}|賞金 ${foe.reward}`;
    const prev = document.getElementById('opp-prev') as HTMLButtonElement;
    const next = document.getElementById('opp-next') as HTMLButtonElement;
    prev.disabled = enemyIdx <= 0;
    next.disabled = enemyIdx >= SAVE.maxLevel; // 沒打贏這關,後面鎖住
    next.textContent = enemyIdx >= SAVE.maxLevel && enemyIdx < ENEMY_ROSTER.length - 1 ? '🔒' : '▶';
    prev.style.opacity = prev.disabled ? '0.3' : '1';
    next.style.opacity = next.disabled ? '0.5' : '1';
  }
  function openMenu() {
    mode = 'menu';
    localStorage.setItem('kd_mode', 'menu');
    document.body.classList.add('ui-menu'); // 藏戰鬥 HUD
    restart();
    setEnemyVisible(false);
    menuEl.classList.add('open');
    battleBtnsEl.classList.add('hidden');
    toggleShop(true);
    updateMenuUI();
  }
  function startBattle() {
    mode = 'battle';
    localStorage.setItem('kd_mode', 'battle');
    document.body.classList.remove('ui-menu');
    menuEl.classList.remove('open');
    battleBtnsEl.classList.remove('hidden');
    toggleShop(false);
    setEnemyVisible(true);
    arenaShape = randomShape(); // 每場隨機場地
    buildArena(arenaShape);
    buildObstacles(obstacleCountFor(enemyIdx)); // 後面的關卡才有障礙物
    restart();
  }
  function setOpp(delta: number) {
    // 只能在已解鎖範圍內切換
    const target = Math.min(Math.max(enemyIdx + delta, 0), SAVE.maxLevel);
    if (target === enemyIdx) return;
    localStorage.setItem('enemyIdx', String(target));
    localStorage.setItem('kd_mode', 'menu');
    location.reload(); // 角色 GLB 只載本場需要的,換對手要重載
  }
  // 主畫面:滑鼠左鍵拖曳也能旋轉人物
  let dragX: number | null = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { if (mode === 'menu') dragX = e.clientX; });
  window.addEventListener('pointermove', (e) => {
    if (dragX !== null && mode === 'menu') {
      player.rb.setRotation(player.angle + (e.clientX - dragX) * 0.012, true);
      dragX = e.clientX;
    }
  });
  window.addEventListener('pointerup', () => { dragX = null; });

  // ---------- 帳號 UI 與雲端同步 ----------
  const accOut = document.getElementById('acc-out')!;
  const accIn = document.getElementById('acc-in')!;
  const accName = document.getElementById('acc-name')!;
  const accStats = document.getElementById('acc-stats')!;
  const accErr = document.getElementById('acc-err')!;
  function renderAccount() {
    const u = currentUser;
    accOut.style.display = u ? 'none' : 'block';
    accIn.style.display = u ? 'block' : 'none';
    if (u) accName.textContent = u.isAnonymous ? `訪客-${u.uid.slice(0, 4)}` : (u.displayName || u.email || u.uid.slice(0, 8));
    accStats.textContent = `戰績:${SAVE.wins} 勝 ${SAVE.losses} 敗`;
  }
  function doLogin(fn: () => Promise<unknown>) {
    accErr.textContent = '';
    fn().catch((e: Error) => { accErr.textContent = `登入失敗:${e.message.slice(0, 60)}`; });
  }
  document.getElementById('btn-google')!.addEventListener('click', () => doLogin(loginGoogle));
  document.getElementById('btn-apple')!.addEventListener('click', () => doLogin(loginApple));
  document.getElementById('btn-anon')!.addEventListener('click', () => doLogin(loginAnon));
  document.getElementById('btn-logout')!.addEventListener('click', () => { logout(); });
  watchAuth(async (u) => {
    currentUser = u;
    renderAccount();
    if (!u) return;
    try {
      const cloud = await cloudLoad(u);
      if (cloud && cloud.data) {
        // 雲端有存檔 → 雲端為準;正規化後比對,不同才重載(避免無限重載)
        const cloudNorm = JSON.stringify(normalizeSave(cloud.data));
        if (cloudNorm !== JSON.stringify(SAVE)) {
          localStorage.setItem('kd_save', cloudNorm);
          localStorage.setItem('kd_mode', 'menu');
          location.reload();
        }
      } else {
        // 首次登入:把本地進度上雲
        cloudSave(u, SAVE).catch(() => {});
      }
    } catch (e) {
      accErr.textContent = '雲端同步失敗(進度仍存在本機)';
      console.warn('cloud sync', e);
    }
  });
  renderAccount();

  // 開場畫面:點「進入遊戲」同時解鎖 AudioContext(瀏覽器要求使用者手勢後才准出聲)
  const titleEl = document.getElementById('titlescreen')!;
  if (sessionStorage.getItem('kd_title_seen')) titleEl.style.display = 'none';
  document.getElementById('btn-start')!.addEventListener('click', () => {
    sessionStorage.setItem('kd_title_seen', '1');
    titleEl.style.display = 'none';
    if (isTouch) document.getElementById('touch-controls')!.style.display = 'block';
    document.getElementById('btn-sound')!.style.display = '';
    initAudio().then(() => playSfx('clangHeavy', 0.6));
    openMenu(); // 表演賽結束,進主畫面
  });
  // 保險:略過開場畫面的重載也要能解鎖音效
  window.addEventListener('pointerdown', () => { initAudio(); }, { once: true });

  // ---------- PWA 安裝按鈕 ----------
  // Android/Chrome:beforeinstallprompt 可一鍵安裝;iOS 沒有 API,改顯示手動教學
  let installPrompt: { prompt: () => Promise<unknown> } | null = null;
  const installBtns = [document.getElementById('btn-install')!, document.getElementById('btn-install2')!];
  const iosGuide = document.getElementById('ios-guide')!;
  const isStandalone = matchMedia('(display-mode: standalone)').matches
    || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  function showInstallBtns(show: boolean) {
    for (const b of installBtns) b.style.display = show ? 'inline-block' : 'none';
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as unknown as { prompt: () => Promise<unknown> };
    if (!isStandalone) showInstallBtns(true);
  });
  if (!isStandalone && isIOS) showInstallBtns(true);
  for (const b of installBtns) {
    b.addEventListener('click', () => {
      playSfx('click', 0.6);
      if (installPrompt) { void installPrompt.prompt(); }
      else iosGuide.classList.add('open');
    });
  }
  document.getElementById('ig-close')!.addEventListener('click', () => iosGuide.classList.remove('open'));
  window.addEventListener('appinstalled', () => showInstallBtns(false));

  // 聲音開關(狀態記在 localStorage)
  const soundBtn = document.getElementById('btn-sound')!;
  function renderSoundBtn() {
    soundBtn.textContent = sfxMuted ? '🔇' : '🔊';
    soundBtn.classList.toggle('muted', sfxMuted);
  }
  soundBtn.addEventListener('click', () => {
    sfxMuted = !sfxMuted;
    localStorage.setItem('kd_muted', sfxMuted ? '1' : '0');
    renderSoundBtn();
    if (!sfxMuted) { initAudio().then(() => playSfx('click', 0.6)); } // 開聲時回饋一聲
  });
  renderSoundBtn();
  // 開場畫面蓋著時藏起來(會浮在標題上),進入遊戲才出現
  if (titleEl.style.display !== 'none') soundBtn.style.display = 'none';

  document.getElementById('btn-fight')!.addEventListener('click', () => { playSfx('click', 0.6); startBattle(); });
  document.getElementById('btn-restart')!.addEventListener('click', () => { playSfx('click', 0.6); restart(); });
  document.getElementById('btn-shop2')!.addEventListener('click', () => { playSfx('click', 0.6); toggleShop(); });
  document.getElementById('btn-menu')!.addEventListener('click', () => { playSfx('click', 0.6); openMenu(); });
  document.getElementById('opp-prev')!.addEventListener('click', () => setOpp(-1));
  document.getElementById('opp-next')!.addEventListener('click', () => setOpp(1));
  // 除錯後門只在開發模式開:正式版不給「開 console 一行改金幣」的邀請
  // (真的想作弊仍可能,重要判定的防線在伺服器端驗證)
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__game = { player, enemy, CFG, WEAPONS, SHIELDS, SAVE, persistSave, reloadWithCloudSync };
    (window as unknown as Record<string, unknown>).__dev = { getToken: () => currentUser?.getIdToken() };
  }

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
  const pools: { mesh: THREE.Mesh; age: number; sizeMult: number }[] = [];
  function spawnPool(at: THREE.Vector3, sizeMult = 1) {
    const mesh = new THREE.Mesh(poolGeo, poolMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, 0.02 + pools.length * 0.002, at.z);
    mesh.scale.setScalar(0.01);
    pools.push({ mesh, age: 0, sizeMult });
    scene.add(mesh);
  }
  function updatePools(dt: number) {
    for (const p of pools) {
      p.age += dt;
      p.mesh.scale.setScalar(Math.min(1, p.age * 1.5) * 0.9 * S * p.sizeMult);
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
    playSfx('fleshHeavy', 1);
    playSfx('clangHeavy', 0.8); // 盔甲部件散落
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
  let lastClangAt = -9;
  const lastHitAt = new Map<string, number>();

  function updateHpBars() {
    hpFillPlayer.style.width = `${(player.hp / player.maxHp) * 100}%`;
    hpFillEnemy.style.width = `${(enemy.hp / enemy.maxHp) * 100}%`;
  }

  // 斷肢/受擊提示(短暫顯示,不蓋過勝負訊息)
  let flashTimer: number | undefined;
  function flashMsg(text: string) {
    if (gameOver || mode === 'attract') return;
    msgEl.textContent = text;
    msgEl.style.display = 'block';
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { if (!gameOver) msgEl.style.display = 'none'; }, 1100);
  }

  function swordHitCheck(attacker: Knight, victim: Knight) {
    if (gameOver) return;
    if (!attacker.swordArm.joint) return; // 持劍手被砍斷就無法攻擊
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
    playSfx(dmg > 45 ? 'fleshHeavy' : 'flesh', Math.min(0.95, 0.35 + dmg / 80));
    updateHpBars();

    // 中途斷肢:重擊才有機會,打到哪半邊斷哪隻手(右=持劍手,左=持盾手)
    if (victim.hp > 0 && dmg > 45) {
      const lx = cx - v.x, ly = cy - v.y;
      const va = victim.angle;
      const localY = -Math.sin(va) * lx + Math.cos(va) * ly;
      const targetArm = localY < 0 ? victim.swordArm : victim.shieldArm;
      if (targetArm.joint && Math.random() < Math.min(0.5, dmg / 160)) {
        victim.severArm(targetArm, impact.x, impact.y);
        const armName = targetArm === victim.swordArm ? '持劍手' : '持盾手';
        flashMsg(victim.isPlayer ? `你的${armName}被砍斷了!` : `砍斷了敵人的${armName}!`);
      }
    }

    if (victim.hp <= 0) handleVictory(attacker, victim, impact);
  }

  // 破盾與反傷:刃打中盾面時觸發(隱性相剋,遊戲內不提示)
  const lastShieldHitAt = new Map<number, number>();
  function handleShieldHit(attacker: Knight, defender: Knight) {
    if (gameOver) return;
    if (clock - (lastShieldHitAt.get(attacker.index) ?? -9) < 0.25) return;
    lastShieldHitAt.set(attacker.index, clock);
    // 破盾:順著揮擊方向把盾撞開——斧系把龜殼掀出破綻,杖戳盾則幾乎滑開
    if (defender.shieldArm.joint) {
      const speed = Math.min(1.5, Math.abs(attacker.weaponPreW) / 6 + 0.3);
      defender.shieldArm.rb.applyTorqueImpulse(
        Math.sign(attacker.weaponPreW || 1) * attacker.weapon.shieldBreak * speed * 0.6, true
      );
      if (attacker.weapon.shieldBreak >= 1.2 && Math.abs(attacker.weaponPreW) > 4) playSfx('clangHeavy', 0.55);
    }
    // 反傷:尖刺盾刺傷攻擊者
    const thorns = defender.shield.thorns ?? 0;
    if (thorns > 0 && attacker.hp > 0) {
      attacker.hp = Math.max(0, attacker.hp - thorns);
      attacker.flashUntil = clock + 0.1;
      const sp = defender.shieldArm.rb.translation();
      spawnBlood(to3D({ x: sp.x, y: sp.y }, 0.9 * S), 8);
      playSfx('flesh', 0.4, 1.15);
      updateHpBars();
      if (attacker.hp <= 0) handleVictory(defender, attacker, { x: 0.5, y: 0.5 });
    }
  }

  // 勝負處理(劍殺與尖刺盾反傷致死共用)
  function handleVictory(attacker: Knight, victim: Knight, impact: { x: number; y: number }) {
    {
      gameOver = true;
      shatter(victim, impact);
      attacker.victoryPose();
      if (mode === 'attract') {
        // 表演賽:不發賞金不顯示訊息,歡呼完換個場地重打一場,無限循環
        clearTimeout(menuTimer);
        menuTimer = window.setTimeout(() => {
          if (mode === 'attract') { arenaShape = randomShape(); buildArena(arenaShape); buildObstacles(3); restart(); }
        }, 2400);
        return;
      }
      let advanceToNext = false;
      if (victim.isPlayer) {
        SAVE.losses += 1;
        persistSave();
        msgEl.textContent = '你被擊敗了…';
      } else {
        SAVE.gold += foe.reward;
        SAVE.wins += 1;
        // 打贏當前最高關 → 解鎖下一關並自動前往
        if (enemyIdx === SAVE.maxLevel && enemyIdx < ENEMY_ROSTER.length - 1) {
          SAVE.maxLevel = enemyIdx + 1;
          advanceToNext = true;
          msgEl.textContent = `你贏了!+${foe.reward} 金幣|解鎖第 ${enemyIdx + 2} 關:${ENEMY_ROSTER[enemyIdx + 1].label}`;
        } else {
          msgEl.textContent = `你贏了!+${foe.reward} 金幣`;
        }
        persistSave();
        updateGold();
        setTimeout(() => playSfx('coins', 0.9), 500);
      }
      renderAccount();
      msgEl.style.display = 'block';
      // 讓殘骸飛一下;解鎖新關卡→直接前往下一關的主畫面,否則回主畫面
      clearTimeout(menuTimer);
      menuTimer = window.setTimeout(() => {
        if (!gameOver) return;
        if (advanceToNext) {
          void reloadWithCloudSync(() => {
            localStorage.setItem('enemyIdx', String(SAVE.maxLevel));
            localStorage.setItem('kd_mode', 'menu');
          });
        } else openMenu();
      }, 2800);
    }
  }

  // ---------- 輸入 ----------
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.key.startsWith('Arrow')) e.preventDefault();
    const k = e.key.toLowerCase();
    keys.add(k);
    if (k === 'r' && mode === 'battle') restart();
    if (k === 'b') toggleShop();
    if (k === 'n') setOpp(1);
    if (k === 'escape' && mode === 'battle') openMenu();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

  // 觸控按鈕:按住=按鍵按住,直接餵進 keys(多點觸控,邊轉邊走)
  // 開場畫面蓋著時先不顯示(會從半透明遮罩底下露出來很亂),進入遊戲才開
  if (isTouch) {
    if (document.getElementById('titlescreen')!.style.display === 'none') {
      document.getElementById('touch-controls')!.style.display = 'block';
    }
    const bindTouch = (id: string, key: string) => {
      const el = document.getElementById(id)!;
      const down = (e: PointerEvent) => { e.preventDefault(); keys.add(key); el.classList.add('on'); };
      const up = () => { keys.delete(key); el.classList.remove('on'); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    bindTouch('tc-left', 'arrowleft');
    bindTouch('tc-right', 'arrowright');
    bindTouch('tc-up', 'arrowup');
    bindTouch('tc-down', 'arrowdown');
  }

  function restart() {
    clearBattlefield();
    player.reset();
    enemy.reset();
    gameOver = false;
    msgEl.style.display = 'none';
    updateHpBars();
  }

  // ---------- 個性化 AI(self 打 target;attract 模式兩邊都掛) ----------
  function updateAI(self: Knight, target: Knight, dt: number) {
    const P = AI_STYLES[self.aiStyle];
    const p = target.pos, e = self.pos;
    const dx = p.x - e.x, dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const ux = dx / dist, uy = dy / dist; // 指向對手的單位向量
    const targetAngle = Math.atan2(dy, dx);
    const diff = wrapAngle(targetAngle - self.angle + P.aimLead);
    // 狂暴:血越低越快越兇(最多 +70%)
    const rage = P.berserk ? 1 + (1 - self.hp / self.maxHp) * 0.7 : 1;

    // 斷臂逃命:持劍手沒了打不了人,能逃多遠逃多遠
    if (!self.swordArm.joint) {
      self.rb.applyImpulse({ x: -ux * CFG.moveForce * 1.2 * dt, y: -uy * CFG.moveForce * 1.2 * dt }, true);
      const w0 = self.rb.angvel();
      self.turn(diff * 4 - w0 * 1.5, dt);
      return;
    }

    // 反陀螺:對手的刀還在轉就退到掃不到的地方等;狂暴殘血時不管,直接撲
    const targetSpinning = Math.abs(target.rb.angvel()) > 2.5 || (target.exhausted && target.stamina >= 45);
    const suicidal = P.berserk && self.hp < self.maxHp * 0.3;
    if (targetSpinning && !suicidal && !P.spinner) {
      const w = self.rb.angvel();
      self.turn(diff * 6 - w * 1.5, dt); // 面向盯著
      if (dist < 0.49 + CFG.bladeStart + target.weapon.length + P.spinMargin) {
        self.rb.applyImpulse({ x: -ux * CFG.moveForce * self.moveMult * dt, y: -uy * CFG.moveForce * self.moveMult * dt }, true);
        const lv2 = self.rb.linvel();
        if (Math.hypot(lv2.x, lv2.y) < 0.3) {
          const side = Math.sin(clock * 2) > 0 ? 1 : -1;
          self.rb.applyImpulse({ x: -uy * side * CFG.moveForce * dt, y: ux * side * CFG.moveForce * dt }, true);
        }
      }
      return; // 不出手也不進場,等
    }

    // 懲罰模式:對手力竭(刀也停了)→全速撲上去加倍出手;體力回 45 提前撤
    if (target.exhausted && target.stamina < 45) {
      const w = self.rb.angvel();
      self.turn(diff * 8 - w * 1.5, dt);
      if (dist > 1.5) {
        self.rb.applyImpulse({ x: ux * CFG.moveForce * 1.5 * self.moveMult * dt, y: uy * CFG.moveForce * 1.5 * self.moveMult * dt }, true);
      }
      self.swingTimer -= dt * 2 * rage;
      if (self.swingTimer <= 0 && dist < 2.9 * S) {
        self.swingDir *= -1;
        self.rb.applyTorqueImpulse(self.swingDir * CFG.aiSwingImpulse * self.swingMult, true);
        self.swingTimer = (1.1 + Math.random() * 0.8) / self.swingMult;
        self.lastSwingAt = clock;
      }
      return;
    }

    // 陀螺鏡像:用玩家的蓄力旋轉打法,還會管理體力
    if (P.spinner) {
      if (self.exhausted || self.stamina < 25) {
        // 沒力了:拉開喘氣
        self.rb.applyImpulse({ x: -ux * CFG.moveForce * self.moveMult * dt, y: -uy * CFG.moveForce * self.moveMult * dt }, true);
      } else {
        self.turn(CFG.turnTorque * 0.9 * self.swingDir, dt); // 持續蓄轉
        if (dist > P.engage * S) {
          self.rb.applyImpulse({ x: ux * CFG.moveForce * 0.8 * self.moveMult * dt, y: uy * CFG.moveForce * 0.8 * self.moveMult * dt }, true);
        }
      }
      return;
    }

    // 側向遊走(刺客/風箏手)
    if (P.strafe > 0 && dist < 4.5 * S) {
      const sway = Math.sin(clock * 1.8 + self.index * 3);
      self.rb.applyImpulse({ x: -uy * sway * P.strafe * CFG.moveForce * 0.5 * dt, y: ux * sway * P.strafe * CFG.moveForce * 0.5 * dt }, true);
    }

    // 出手判斷:距離 + 個性條件
    const bladeOff = Math.abs(wrapAngle(target.swordArm.rb.rotation() - Math.atan2(-dy, -dx)));
    const opening = bladeOff > 1.1; // 對手刀口偏離自己 60°+
    let canSwing = dist < P.swingAt * S;
    if (P.counterOnly) canSwing = canSwing && (target.stamina < 55 || dist < 1.5 * S);
    if (P.ambush) canSwing = canSwing && opening;

    self.swingTimer -= dt * P.swingRate * rage;
    if (self.swingTimer <= 0 && canSwing) {
      self.swingDir *= -1;
      self.rb.applyTorqueImpulse(self.swingDir * CFG.aiSwingImpulse * self.swingMult * (self.exhausted ? 0.3 : 1) * rage, true);
      self.swingTimer = (1.1 + Math.random() * 0.8) / self.swingMult;
      self.lastSwingAt = clock;
    } else if (clock - self.lastSwingAt > 0.5) {
      const w = self.rb.angvel();
      self.turn(diff * 6 - w * 1.5, dt);
    }

    // 走位:風箏手卡自己武器射程;其他人照個性的進退距離
    if (P.kite) {
      const pref = 0.49 + CFG.bladeStart + self.weapon.length - 0.4;
      if (dist > pref + 0.7 && Math.abs(diff) < 0.9) self.forward(CFG.moveForce * self.moveMult * rage, dt);
      else if (dist < pref - 0.4) self.rb.applyImpulse({ x: -ux * CFG.moveForce * self.moveMult * dt, y: -uy * CFG.moveForce * self.moveMult * dt }, true);
    } else {
      if (dist > P.engage * S && Math.abs(diff) < 0.7) self.forward(CFG.moveForce * self.moveMult * rage, dt);
      else if (dist < P.retreatAt * S) self.forward(-CFG.moveForce * 0.6, dt);
    }

    // 解僵局:想前進卻推不動→往側面繞開
    const lv = self.rb.linvel();
    if (dist > P.engage * S && Math.hypot(lv.x, lv.y) < 0.4) self.stuckTime += dt;
    else self.stuckTime = 0;
    if (self.stuckTime > 0.7) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const a2 = self.angle;
      self.rb.applyImpulse({ x: -Math.sin(a2) * side * 1.5, y: Math.cos(a2) * side * 1.5 }, true);
      self.stuckTime = 0;
    }
  }

  // ---------- 主迴圈 ----------
  let last = performance.now();
  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    clock += dt;

    if (mode === 'battle' && !gameOver && !shopOpen && titleEl.style.display === 'none') {
      if (keys.has('arrowleft') || keys.has('a')) player.turn(CFG.turnTorque, dt);
      if (keys.has('arrowright') || keys.has('d')) player.turn(-CFG.turnTorque, dt);
      if (keys.has('arrowup') || keys.has('w')) player.forward(CFG.moveForce, dt);
      if (keys.has('arrowdown') || keys.has('s')) player.forward(-CFG.moveForce * 0.7, dt);
      updateAI(enemy, player, dt);
    } else if (mode === 'attract' && !gameOver) {
      // 開場表演賽:兩邊都是 AI
      updateAI(enemy, player, dt);
      updateAI(player, enemy, dt);
    } else if (mode === 'menu') {
      // 主畫面:左右鍵旋轉人物看造型
      if (keys.has('arrowleft') || keys.has('a')) player.rb.setRotation(player.angle + 2.4 * dt, true);
      if (keys.has('arrowright') || keys.has('d')) player.rb.setRotation(player.angle - 2.4 * dt, true);
    }

    player.updateStamina(dt);
    enemy.updateStamina(dt);
    staminaEl.classList.toggle('exhausted', player.exhausted);
    staminaFill.style.width = `${player.stamina}%`;

    player.captureVel();
    enemy.captureVel();
    world.step(eventQueue);
    // 碰撞事件:金屬碰撞聲 + 破盾/反傷(判傷本體仍是幾何判定)
    eventQueue.drainCollisionEvents((h1: number, h2: number, started: boolean) => {
      if (!started) return;
      const a = colInfo.get(h1), b = colInfo.get(h2);
      if (a && b && a.knight !== b.knight) {
        // 刃打到盾面 → 破盾撞擊 + 尖刺反傷
        if (a.kind === 'blade' && b.kind === 'shield') handleShieldHit(a.knight, b.knight);
        else if (b.kind === 'blade' && a.kind === 'shield') handleShieldHit(b.knight, a.knight);
        if (clock - lastClangAt > 0.09) { lastClangAt = clock; playSfx('clang', 0.5); }
      } else if ((a && wallColHandles.has(h2)) || (b && wallColHandles.has(h1))) {
        if (clock - lastClangAt > 0.09) { lastClangAt = clock; playSfx('clang', 0.25, 0.7); }
      }
    });
    swordHitCheck(player, enemy);
    swordHitCheck(enemy, player);

    player.sync(clock, dt);
    enemy.sync(clock, dt);
    updateParticles(dt);
    updatePools(dt);
    updateDebris(dt);

    // 鏡頭:主畫面=貼近看主角造型;戰鬥=中點跟隨+距離縮放,指數平滑不暈
    const k = 1 - Math.exp(-3 * dt);
    if (mode === 'menu') {
      // 主角擺在畫面左半空間的中間:看點沿鏡頭右向偏移,人物就往左讓
      const pp = player.pos;
      const eye = new THREE.Vector3(pp.x + 2.4, 2.6, -pp.y + 2.9);
      const tgt = new THREE.Vector3(pp.x, 1.0, -pp.y);
      const dirv = tgt.clone().sub(eye).normalize();
      const rightv = new THREE.Vector3().crossVectors(dirv, camera.up).normalize();
      tgt.addScaledVector(rightv, 1.05);
      camPos.lerp(eye, k);
      camLook.lerp(tgt, k);
    } else {
      const pp = player.pos, ep = enemy.pos;
      const midX = (pp.x + ep.x) / 2, midY = (pp.y + ep.y) / 2;
      const sep = Math.hypot(pp.x - ep.x, pp.y - ep.y);
      const h = THREE.MathUtils.clamp(8 + sep * 1.1, 10.5, 16.5);
      camPos.lerp(new THREE.Vector3(midX, h, -midY + h * 0.35), k);
      camLook.lerp(new THREE.Vector3(midX, 0, -midY), k);
    }
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

  // 進場:首次=開場畫面+AI表演賽;之後照 kd_mode 回主畫面或戰鬥
  if (mode === 'attract') {
    battleBtnsEl.classList.add('hidden');
    setEnemyVisible(true);
    buildObstacles(3);
    restart();
  } else if (mode === 'menu') openMenu();
  else startBattle();
}
