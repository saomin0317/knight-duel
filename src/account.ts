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

export async function cloudSave(user: User, data: unknown): Promise<void> {
  const token = await user.getIdToken();
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`save ${res.status}`);
}
