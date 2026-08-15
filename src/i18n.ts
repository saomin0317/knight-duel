// 介面語言:繁中 / 英文
// 判定順序:localStorage 'kw-lang'(玩家手動切換過) → navigator.language 開頭是 zh → zh,其餘 → en。
// 只管「介面文案」;台灣遊戲分級標章的法規文字照法規原樣保留(見 index.html #ts-rating)。
export type Lang = 'zh' | 'en';

const ZH = {
  // ---- 開場 / 載入 ----
  'game.name': '⚔ 武士圓舞曲',
  'ts.sub': "Knight's Waltz・俯視角物理決鬥",
  'loading.text': '載入中…',
  'loading.failed': '載入失敗,請重新整理再試',
  'btn.start': '進入遊戲',
  'btn.install': '📲 安裝成 App',
  'link.about': '關於本遊戲',
  'link.terms': '服務條款',
  'link.privacy': '隱私權政策',
  'rating.en': '', // 英文模式才在分級標章旁補這行(中文模式不顯示)
  // ---- 主畫面 ----
  'hero.l1': '◀ ▶ 或滑鼠拖曳旋轉人物',
  'hero.l2': '鐵匠鋪買的裝備會直接穿在身上',
  'btn.fight': '⚔ 開始戰鬥',
  'btn.lb': '🏆 排行榜',
  'menu.level': '第 {n} 關|{name}|血量 x{hp}|賞金 {reward}',
  'lang.btn': 'EN',
  'lang.title': 'Switch to English',
  // ---- 帳號 ----
  'acc.head': '帳號',
  'acc.google': 'Google 登入',
  'acc.apple': ' Apple 登入',
  'acc.anon': '訪客遊玩',
  'acc.legal': '登入即表示同意',
  'acc.and': '與',
  'acc.logout': '登出',
  'acc.guest': '訪客-{id}',
  'acc.record': '戰績:{w} 勝 {l} 敗',
  'acc.loginFail': '登入失敗:{msg}',
  'acc.syncFail': '雲端同步失敗(進度仍存在本機)',
  'acc.offsite': '雲端存檔與排行榜列名,請玩官網版 satsumacreative.tw/kw',
  // ---- 鐵匠鋪 ----
  'shop.title': '鐵匠鋪',
  'shop.weapons': '武器',
  'shop.shields': '盾牌',
  'shop.note': '按 B 開關|買到手後點「裝備」立刻換裝(重開本場)',
  'shop.equipped': '裝備中',
  'shop.equip': '裝備',
  'shop.price': '{n} 金',
  'stat.weapon': '長 {len}|{weight}|威力 x{mult}',
  'stat.shield': '寬 {w}|{weight}',
  'weight.heavy': '重',
  'weight.medium': '中',
  'weight.light': '輕',
  // ---- 戰鬥 HUD ----
  'label.player': '你(藍)',
  'label.enemy': '敵人({name}·賞金{reward})',
  'hud.hint': '← → 旋轉甩劍|↑ ↓ 前後移動|轉太久會力竭,注意黃色體力條',
  'rotate.hint': '📱 轉成橫向比較好打',
  'btn.restart': '重開 (R)',
  'btn.shop': '鐵匠鋪 (B)',
  'btn.menu': '回主畫面',
  'sound.title': '聲音開關',
  // ---- 勝負 / 斷肢 ----
  'arm.sword': '持劍手',
  'arm.shield': '持盾手',
  'msg.armLost': '你的{arm}被砍斷了!',
  'msg.armCut': '砍斷了敵人的{arm}!',
  'msg.defeat': '你被擊敗了…',
  'msg.win': '你贏了!+{gold} 金幣',
  'msg.winUnlock': '你贏了!+{gold} 金幣|解鎖第 {n} 關:{name}',
  // ---- 排行榜 ----
  'lb.title': '🏆 排行榜',
  'lb.loading': '載入中…',
  'lb.rule': '比關卡,同關卡比勝場,再同分先到先贏(每分鐘更新)',
  'lb.empty': '還沒有人上榜,先去打幾場!',
  'lb.col.rank': '名次',
  'lb.col.name': '玩家',
  'lb.col.stage': '關卡',
  'lb.col.wins': '勝場',
  'lb.stage': '第 {n} 關',
  'lb.wins': '{n} 勝',
  'lb.you': '你的名次',
  'lb.offsiteNote': '想列名排行榜?到官網版 satsumacreative.tw/kw 登入遊玩',
  'lb.loginNote': '登入(訪客也行)並打過一場後,這裡會顯示你的名次',
  'lb.error': '排行榜讀取失敗,晚點再試(不影響遊戲)',
  'lb.close': '關閉',
  // ---- iOS 安裝教學(含 <b> 標記,以 innerHTML 塞) ----
  'ig.title': '安裝到 iPhone 主畫面:',
  'ig.s1': '1. 點 Safari 下方的<b>分享</b>鈕',
  'ig.s2': '2. 往下捲,選<b>「加入主畫面」</b>',
  'ig.s3': '3. 點<b>「新增」</b>完成!',
  'ig.foot': '之後從主畫面開啟就是全螢幕 App',
  'ig.ok': '知道了',
  // ---- 武器 ----
  'weapon.sword1h': '短劍',
  'weapon.axe1h': '單手斧',
  'weapon.staff': '長木杖',
  'weapon.skelBlade': '骷髏彎刀',
  'weapon.skelStaff': '骨杖',
  'weapon.sword2h': '雙手大劍',
  'weapon.skelAxe': '骷髏斧',
  'weapon.axe2h': '雙手大斧',
  // ---- 盾牌 ----
  'shield.badge': '徽章小盾',
  'shield.skelSmallA': '骨片小盾',
  'shield.skelSmallB': '裂骨小盾',
  'shield.round': '圓盾',
  'shield.square': '方盾',
  'shield.skelLargeA': '骨牆大盾',
  'shield.skelLargeB': '骸骨大盾',
  'shield.spikes': '尖刺盾',
  // ---- 敵人(12 關) ----
  'foe.skelMinion': '骷髏小兵',
  'foe.rogue': '盜賊',
  'foe.skelRogue': '骷髏遊蕩者',
  'foe.assassin': '刺客',
  'foe.skelMage': '骷髏法師',
  'foe.barbarian': '野蠻人',
  'foe.mage': '法師',
  'foe.skelWarrior': '骷髏戰士',
  'foe.shadow': '影武者',
  'foe.warlord': '蠻王',
  'foe.archmage': '大法師',
  'foe.skelKing': '骷髏王',
} as const;

export type Key = keyof typeof ZH;

const EN: Record<Key, string> = {
  'game.name': "⚔ Knight's Waltz",
  'ts.sub': 'TOP-DOWN PHYSICS DUELING',
  'loading.text': 'Loading…',
  'loading.failed': 'Failed to load — please refresh and try again',
  'btn.start': 'Enter the Arena',
  'btn.install': '📲 Install as App',
  'link.about': 'About This Game',
  'link.terms': 'Terms of Service',
  'link.privacy': 'Privacy Policy',
  'rating.en': 'Contains blood and dismemberment. Rated 15+ in Taiwan.',
  'hero.l1': '◀ ▶ or drag with the mouse to turn your knight',
  'hero.l2': 'Gear bought at the smithy is worn right away',
  'btn.fight': '⚔ Fight',
  'btn.lb': '🏆 Leaderboard',
  'menu.level': 'Stage {n} | {name} | HP x{hp} | Bounty {reward}',
  'lang.btn': '中',
  'lang.title': '切換為中文',
  'acc.head': 'Account',
  'acc.google': 'Sign in with Google',
  'acc.apple': ' Sign in with Apple',
  'acc.anon': 'Play as Guest',
  'acc.legal': 'Signing in means you accept the',
  'acc.and': 'and',
  'acc.logout': 'Sign Out',
  'acc.guest': 'Guest-{id}',
  'acc.record': 'Record: {w}W · {l}L',
  'acc.loginFail': 'Sign-in failed: {msg}',
  'acc.syncFail': 'Cloud sync failed (progress kept on this device)',
  'acc.offsite': 'For cloud saves and leaderboard ranking, play the official build at satsumacreative.tw/kw',
  'shop.title': 'Smithy',
  'shop.weapons': 'Weapons',
  'shop.shields': 'Shields',
  'shop.note': 'Press B to toggle | Once bought, hit "Equip" to swap gear (restarts the match)',
  'shop.equipped': 'Equipped',
  'shop.equip': 'Equip',
  'shop.price': '{n} G',
  'stat.weapon': 'Reach {len} | {weight} | Power x{mult}',
  'stat.shield': 'Width {w} | {weight}',
  'weight.heavy': 'Heavy',
  'weight.medium': 'Med',
  'weight.light': 'Light',
  'label.player': 'You (Blue)',
  'label.enemy': 'Enemy ({name} · Bounty {reward})',
  'hud.hint': '← → Spin your blade | ↑ ↓ Move | Spin too long and you gas out — watch the yellow bar',
  'rotate.hint': '📱 Landscape plays better',
  'btn.restart': 'Restart (R)',
  'btn.shop': 'Smithy (B)',
  'btn.menu': 'Main Menu',
  'sound.title': 'Sound on/off',
  'arm.sword': 'sword arm',
  'arm.shield': 'shield arm',
  'msg.armLost': 'Your {arm} was hacked off!',
  'msg.armCut': "Hacked off the enemy's {arm}!",
  'msg.defeat': 'You have fallen…',
  'msg.win': 'Victory! +{gold} gold',
  'msg.winUnlock': 'Victory! +{gold} gold | Stage {n} unlocked: {name}',
  'lb.title': '🏆 Leaderboard',
  'lb.loading': 'Loading…',
  'lb.rule': 'Ranked by stage, then by wins, then by who got there first (updates every minute)',
  'lb.empty': 'Nobody on the board yet — go win a few!',
  'lb.col.rank': 'Rank',
  'lb.col.name': 'Player',
  'lb.col.stage': 'Stage',
  'lb.col.wins': 'Wins',
  'lb.stage': 'Stage {n}',
  'lb.wins': '{n}W',
  'lb.you': 'Your rank',
  'lb.offsiteNote': 'Want a spot on the board? Sign in and play at satsumacreative.tw/kw',
  'lb.loginNote': 'Sign in (guest works too) and finish one match — your rank shows up here',
  'lb.error': "Couldn't load the leaderboard, try again later (the game is unaffected)",
  'lb.close': 'Close',
  'ig.title': 'Add to your iPhone Home Screen:',
  'ig.s1': '1. Tap the <b>Share</b> button in Safari',
  'ig.s2': '2. Scroll down and choose <b>"Add to Home Screen"</b>',
  'ig.s3': '3. Tap <b>"Add"</b> — done!',
  'ig.foot': 'Launch it from the Home Screen for a full-screen app',
  'ig.ok': 'Got it',
  'weapon.sword1h': 'Shortsword',
  'weapon.axe1h': 'Hand Axe',
  'weapon.staff': 'Long Staff',
  'weapon.skelBlade': 'Skeletal Scimitar',
  'weapon.skelStaff': 'Bone Staff',
  'weapon.sword2h': 'Greatsword',
  'weapon.skelAxe': 'Skeletal Axe',
  'weapon.axe2h': 'Greataxe',
  'shield.badge': 'Crest Buckler',
  'shield.skelSmallA': 'Bone Buckler',
  'shield.skelSmallB': 'Cracked Bone Buckler',
  'shield.round': 'Round Shield',
  'shield.square': 'Heater Shield',
  'shield.skelLargeA': 'Bonewall Greatshield',
  'shield.skelLargeB': 'Ossuary Greatshield',
  'shield.spikes': 'Spiked Shield',
  'foe.skelMinion': 'Skeleton Minion',
  'foe.rogue': 'Bandit',
  'foe.skelRogue': 'Skeleton Prowler',
  'foe.assassin': 'Assassin',
  'foe.skelMage': 'Skeleton Mage',
  'foe.barbarian': 'Barbarian',
  'foe.mage': 'Mage',
  'foe.skelWarrior': 'Skeleton Warrior',
  'foe.shadow': 'Shadowblade',
  'foe.warlord': 'Warlord',
  'foe.archmage': 'Archmage',
  'foe.skelKing': 'Skeleton King',
};

const STR: Record<Lang, Record<Key, string>> = { zh: ZH, en: EN };

// 伺服器回的字串一律照顯示,唯一例外:預設名「無名武士」在英文模式做顯示層映射(不改 API)
const SERVER_NAMES: Record<string, string> = { 無名武士: 'Nameless Knight' };

function readStored(): Lang | null {
  try {
    const v = localStorage.getItem('kw-lang');
    return v === 'zh' || v === 'en' ? v : null;
  } catch { return null; }
}
function detect(): Lang {
  const saved = readStored();
  if (saved) return saved;
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang: Lang = detect();
document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';

export function getLang(): Lang { return lang; }

export function setLang(l: Lang): void {
  lang = l;
  try { localStorage.setItem('kw-lang', l); } catch { /* 私密模式寫不進去也照切 */ }
  document.documentElement.lang = l === 'zh' ? 'zh-Hant' : 'en';
}

type Vars = Record<string, string | number>;
export function t(key: Key, vars?: Vars): string {
  const s = STR[lang][key] ?? ZH[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 排行榜等伺服器回傳的玩家名:原則上照顯示,只映射已知的預設名 */
export function mapServerName(name: string): string {
  return lang === 'en' ? (SERVER_NAMES[name] ?? name) : name;
}
