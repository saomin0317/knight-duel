// tools/slim_models.mjs — 角色模型瘦身:只留 main.ts 會播的動畫(抄 kw-survivor/tools/slim_models.mjs)
// KayKit 每個角色內建 75–95 種動畫(每檔約 3.6MB),這裡只用到 KEEP 這幾種。
// 用法(要借五星地下城裝好的 @gltf-transform):
//   cd ~/dev/dungeon-core && node ~/dev/knight-duel/tools/slim_models.mjs
// 就地改寫 public/models/;要播新動畫先用 git 取回原檔(git show <commit>:public/models/X.glb)再重跑。
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { NodeIO } = require("@gltf-transform/core");
const { prune } = require("@gltf-transform/functions");

const KEEP = new Set(["Idle", "Walking_A", "Cheer"]);
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "models");
const CHARS = ["Knight", "Barbarian", "Rogue", "Rogue_Hooded", "Mage", "Skeleton_Warrior", "Skeleton_Minion", "Skeleton_Rogue", "Skeleton_Mage"];

const io = new NodeIO();
for (const name of CHARS) {
  const file = path.join(DIR, name + ".glb");
  const before = fs.statSync(file).size;
  const doc = await io.read(file);
  const anims = doc.getRoot().listAnimations();
  let kept = 0;
  for (const a of anims) {
    if (KEEP.has(a.getName())) { kept++; continue; }
    // 只 dispose 動畫本身,sampler 還會掛著 accessor;要先拆 sampler/channel
    for (const c of a.listChannels()) c.dispose();
    for (const s of a.listSamplers()) s.dispose();
    a.dispose();
  }
  // prune() 不會清被刪動畫留下的孤兒 accessor,手動清
  for (const acc of doc.getRoot().listAccessors()) if (acc.listParents().every((p) => p.propertyType === "Root")) acc.dispose();
  await doc.transform(prune());
  await io.write(file, doc);
  const after = fs.statSync(file).size;
  console.log(`${name.padEnd(18)} 動畫 ${anims.length} → ${kept}  ${(before / 1e6).toFixed(2)}MB → ${(after / 1e6).toFixed(2)}MB`);
}
