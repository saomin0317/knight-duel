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

const API = location.hostname === 'localhost'
  ? 'https://satsumacreative.tw/kw-api/save.php'
  : '/kw-api/save.php';
const LB_API = location.hostname === 'localhost'
  ? 'https://satsumacreative.tw/kw-api/leaderboard.php'
  : '/kw-api/leaderboard.php';

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
