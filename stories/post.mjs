// 夜のストーリーを GitHub Actions から投稿する（8maki）
// 環境変数：IG_ACCESS_TOKEN / IG_USER_ID（Secrets）、SLOT（auto|open|late|shijimi）、DRY_RUN（true=下見）、FORCE（true=時刻・曜日・重複チェックを無視）
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("stories/schedule.json", "utf8"));
const LOG = "stories/log.csv";
const DRY = process.env.DRY_RUN !== "false";
const FORCE = process.env.FORCE === "true";
const want = process.env.SLOT || "auto";
const repo = process.env.GITHUB_REPOSITORY;
const api = "https://graph.facebook.com/v23.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 時刻はすべて日本時間で考える。営業日＝「日本時間 −6時間」の日付（翌3時は前日の営業日）
const jstNow = () => new Date(Date.now() + 9 * 3600e3);
const now = jstNow();
const biz = new Date(now.getTime() - 6 * 3600e3);
const bizDate = biz.toISOString().slice(0, 10);
const bizDow = biz.getUTCDay(); // 0=日曜
const target = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return new Date(Date.parse(bizDate + "T00:00:00Z") + (h * 60 + m) * 60e3); };
const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");

let slot = want;
if (slot === "auto") {
  slot = Object.keys(cfg.枠).find((k) => { const diff = (now - target(cfg.枠[k].時刻)) / 60e3; return diff >= -45 && diff <= cfg.遅れの上限分; });
  if (!slot) { console.log(`今（${fmt(now)}）はどの枠の時間でもありません。何もしません。`); process.exit(0); }
}
const s = cfg.枠[slot];
if (!s) { console.log(`枠「${slot}」はありません`); process.exit(1); }
console.log(`■ ${s.名前}（営業日 ${bizDate}・予定 ${s.時刻}・今 ${fmt(now)}・${DRY ? "下見" : "本番"}）`);

const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "営業日,枠,日時(JST),結果,詳細\n";
let img = null;
const record = (result, detail) => { if (!DRY) fs.writeFileSync(LOG, log + `${bizDate},${slot},${fmt(jstNow())},${result},${String(detail).replace(/[,\n]/g, " ")}${typeof img === "string" ? " " + img : ""}\n`); };
const stop = (msg) => { console.log("→ " + msg + "。投稿しません。"); process.exit(0); };

if (!FORCE) {
  if (bizDow === 0) stop("日曜は定休日");
  if (cfg.休み.includes(bizDate)) stop(`${bizDate} は休みに入っています`);
  if (log.split("\n").some((l) => l.startsWith(`${bizDate},${slot},`) && l.includes(",OK,"))) stop("この枠は今日もう投稿済み");
  const late = (now - target(s.時刻)) / 60e3;
  if (late > cfg.遅れの上限分) { record("見送り", `${Math.round(late)}分遅れ`); stop(`${Math.round(late)}分遅れている`); }
}
if (!s.承認 && !DRY) stop("まだ承認されていない枠（schedule.json の承認が false）");
if (!s.承認) console.log("  ※まだ承認されていない枠です（本番では出しません）。下見なのでチェックだけ続けます");

// 画像が配列なら日替わり：基準日からの営業日（月〜土）の数で順番に回す。全部出し切るまで同じ絵柄は出ない
img = s.画像;
if (Array.isArray(img)) {
  let n = 0; for (let t = Date.parse((cfg.基準日 || "2026-11-16") + "T00:00:00Z"); t < Date.parse(bizDate + "T00:00:00Z"); t += 864e5) if (new Date(t).getUTCDay() !== 0) n++;
  img = img[((n % img.length) + img.length) % img.length];
  console.log(`  日替わり：${s.画像.length}枚中 ${s.画像.indexOf(img) + 1}枚目`);
}
const url = `https://raw.githubusercontent.com/${repo}/main/${img}`;
const head = await fetch(url, { method: "HEAD" });
if (!head.ok) { console.log(`✖ 画像が見えません：${url}（${head.status}）`); process.exit(1); }
console.log(`  画像：${url}`);
if (DRY) {
  const me = await (await fetch(`${api}/${process.env.IG_USER_ID}?fields=username&access_token=${process.env.IG_ACCESS_TOKEN}`)).json();
  if (me.error) { console.log(`✖ Instagramの鍵が使えません：${me.error.message}`); process.exit(1); }
  console.log(`  Instagram：@${me.username} に接続OK`);
  stop("下見モード（チェックはすべてOK）");
}

// 予定より早く起きたときは、予定時刻まで待つ（最大45分）
const early = target(s.時刻) - jstNow();
if (early > 0 && !FORCE) { console.log(`  予定時刻まで ${Math.round(early / 1000)}秒待ちます`); await sleep(early); }

const call = async (method, p, params = {}) => {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = method === "GET" ? await fetch(`${api}/${p}?${body}`) : await fetch(`${api}/${p}`, { method, body });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j;
};
try {
  let c;
  for (let i = 0; i < 3; i++) { try { c = await call("POST", `${process.env.IG_USER_ID}/media`, { image_url: url, media_type: "STORIES" }); break; } catch (e) { if (i === 2) throw e; await sleep(10000); } }
  for (let i = 0; i < 36; i++) { const st = await call("GET", c.id, { fields: "status_code" }); if (st.status_code === "FINISHED") break; if (st.status_code === "ERROR") throw new Error("画像の処理に失敗"); await sleep(5000); }
  const pub = await call("POST", `${process.env.IG_USER_ID}/media_publish`, { creation_id: c.id });
  record("OK", pub.id);
  console.log(`🎉 投稿しました（ID ${pub.id}）`);
} catch (e) {
  record("失敗", e.message);
  console.log(`✖ 投稿に失敗：${e.message}`);
  process.exit(1);
}
