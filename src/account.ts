// 帳號系統:共用 AQ 的 Firebase 專案(Google / Apple / 匿名三種登入),
// 遊戲紀錄存自家 API(satsumacreative.tw/kw-api,MySQL)。
import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, OAuthProvider,
  signInWithPopup, signInAnonymously, onAuthStateChanged, signOut,
  type User,
} from 'firebase/auth';

const app = initializeApp({
  apiKey: 'AIzaSyCFZOJlSEETIijDqUaviPqeUJxGleiBwME',
  authDomain: 'aq-project-c3173.firebaseapp.com',
  projectId: 'aq-project-c3173',
});
export const auth = getAuth(app);

// 外站模式(itch.io 等第三方 iframe 網域):
// (a) 相對路徑 /kw-api/ 會打到人家的網域 → 一律改用絕對網址;
// (b) Firebase 登入 popup 受「授權網域」限制,非官網網域行為不可靠 → 整個登入區藏起來,只走本機存檔。
// 官網(含 www)與 localhost 是完整模式,行為與外站模式無關,維持原樣。
const FULL_HOSTS = ['satsumacreative.tw', 'www.satsumacreative.tw', 'localhost'];
export const IS_OFFSITE = !FULL_HOSTS.includes(location.hostname);

// 同源相對路徑只有「官網本站」用得到;localhost 與外站都打絕對網址
const SAME_ORIGIN = !IS_OFFSITE && location.hostname !== 'localhost';
const API = SAME_ORIGIN
  ? '/kw-api/save.php'
  : 'https://satsumacreative.tw/kw-api/save.php';
const LB_API = SAME_ORIGIN
  ? '/kw-api/leaderboard.php'
  : 'https://satsumacreative.tw/kw-api/leaderboard.php';

export function loginGoogle() { return signInWithPopup(auth, new GoogleAuthProvider()); }
export function loginApple() { return signInWithPopup(auth, new OAuthProvider('apple.com')); }
export function loginAnon() { return signInAnonymously(auth); }
export function logout() { return signOut(auth); }
export function watchAuth(cb: (u: User | null) => void) { return onAuthStateChanged(auth, cb); }

export async function cloudLoad(user: User): Promise<{ data: unknown; name: string } | null> {
  const token = await user.getIdToken();
  const res = await fetch(API, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`load ${res.status}`);
  const j = await res.json();
  return j.ok ? { data: j.data, name: j.name } : null;
}

// 排行榜:公開可讀;有登入就附 token,伺服器會多回自己的名次(沒進前 50 也回)
export type LbRow = { rank: number; name: string; maxLevel: number; wins: number };
export async function fetchLeaderboard(user: User | null): Promise<{ rows: LbRow[]; me?: LbRow }> {
  const headers: Record<string, string> = {};
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  const res = await fetch(LB_API, { headers });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  const j = await res.json();
  if (!j.ok) throw new Error('leaderboard failed');
  return { rows: Array.isArray(j.rows) ? j.rows : [], me: j.me };
}

export async function cloudSave(user: User, data: unknown): Promise<void> {
  const token = await user.getIdToken();
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`save ${res.status}`);
}
