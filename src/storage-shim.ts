// 遊戲被包在別站 iframe(CrazyGames)時,瀏覽器可能擋掉 localStorage,一碰就丟例外 → 整個遊戲卡在載入中
// 擋掉時換成記憶體版:能玩,只是關掉分頁就不保留
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    const s = window[name];
    s.setItem('__kw_probe', '1');
    s.removeItem('__kw_probe');
  } catch {
    try { Object.defineProperty(window, name, { value: memStorage(), configurable: true }); } catch { /* 忽略 */ }
  }
}
export {};
