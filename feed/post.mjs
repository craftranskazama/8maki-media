// 通常投稿（カルーセル・リール・1枚）を GitHub Actions から出す（8maki）
// feed/queue.json の「日付が今日・承認true・まだ出していない」ものを、予定時刻（既定18:00）に投稿する。
// 環境変数：IG_ACCESS_TOKEN / IG_USER_ID、DRY_RUN（true=下見）、FORCE（true=時刻チェックを無視）、DATE（テスト用に日付を指定）
import fs from "node:fs";

const queue = JSON.parse(fs.readFileSync("feed/queue.json", "utf8"));
const LOG = "feed/log.csv";
const DRY = process.env.DRY_RUN !== "false";
const FORCE = process.env.FORCE === "true";
const repo = process.env.GITHUB_REPOSITORY;
const api = "https://graph.facebook.com/v23.0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jstNow = () => new Date(Date.now() + 9 * 3600e3);
const fmt = (d) => d.toISOString().slice(0, 16).replace("T", " ");
const now = jstNow();
const today = process.env.DATE || now.toISOString().slice(0, 10);
const log = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "日付,種類,日時(JST),結果,詳細\n";
const stop = (msg) => { console.log("→ " + msg + "。投稿しません。"); process.exit(0); };

const e = queue.find((q) => q.日付 === today);
if (!e) stop(`${today} の予定はありません`);
const at = new Date(Date.parse(`${today}T${e.時刻 || "18:00"}:00Z`));
console.log(`■ ${today} ${e.時刻 || "18:00"}｜${e.種類}｜${e.名前}（今 ${fmt(now)}・${DRY ? "下見" : "本番"}）`);
const record = (r, d) => { if (!DRY) fs.writeFileSync(LOG, log + `${today},${e.種類},${fmt(jstNow())},${r},${String(d).replace(/[,\n]/g, " ")}\n`); };
if (log.split("\n").some((l) => l.startsWith(`${today},`) && l.includes(",OK,"))) stop("今日はもう投稿済み");
if (!FORCE) { const late = (now - at) / 60e3; if (late < -50) stop("まだ時間前"); if (late > 90) { record("見送り", `${Math.round(late)}分遅れ`); stop(`${Math.round(late)}分遅れている`); } }
if (!e.承認 && !DRY) stop("まだ承認されていない（queue.json の承認が false）");
if (!e.承認) console.log("  ※まだ承認されていません（本番では出しません）。下見なのでチェックだけ続けます");

const caption = fs.readFileSync(e.キャプション, "utf8").trim();
if (/【確認中】/.test(caption)) { console.log("✖ キャプションに【確認中】が残っています"); process.exit(1); }
const raw = (p) => `https://raw.githubusercontent.com/${repo}/main/${p}`;
for (const f of e.ファイル) {
  if (!fs.existsSync(f)) { console.log(`✖ ファイルがありません：${f}`); process.exit(1); }
  if (/\.jpe?g$/i.test(f)) { const h = await fetch(raw(f), { method: "HEAD" }); if (!h.ok) { console.log(`✖ 画像が見えません：${f}`); process.exit(1); } }
}
console.log(`  ${e.ファイル.length}点・キャプション${[...caption].length}字`);
const call = async (method, p, params = {}) => {
  const body = new URLSearchParams({ ...params, access_token: process.env.IG_ACCESS_TOKEN });
  const r = method === "GET" ? await fetch(`${api}/${p}?${body}`) : await fetch(`${api}/${p}`, { method, body });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j;
};
const me = await call("GET", process.env.IG_USER_ID, { fields: "username" }).catch((err) => ({ error: err.message }));
if (me.error) { console.log(`✖ Instagramにつながりません：${me.error}`); record("失敗", me.error); process.exit(1); }
console.log(`  Instagram：@${me.username} に接続OK`);
if (DRY) stop("下見モード（チェックはすべてOK）");

const early = at - jstNow();
if (early > 0 && !FORCE) { console.log(`  予定時刻まで ${Math.round(early / 1000)}秒待ちます`); await sleep(early); }

const ig = process.env.IG_USER_ID;
const wait = async (id) => { for (let i = 0; i < 120; i++) { const s = await call("GET", id, { fields: "status_code,status" }); if (s.status_code === "FINISHED") return; if (s.status_code === "ERROR") throw new Error("処理に失敗：" + s.status); await sleep(5000); } throw new Error("処理が10分で終わりませんでした"); };
const video = async (f, params) => {
  const c = await call("POST", `${ig}/media`, { ...params, upload_type: "resumable" });
  const r = await fetch(`https://rupload.facebook.com/ig-api-upload/v23.0/${c.id}`, { method: "POST", headers: { Authorization: `OAuth ${process.env.IG_ACCESS_TOKEN}`, offset: "0", file_size: String(fs.statSync(f).size) }, body: fs.readFileSync(f) });
  if (!r.ok) throw new Error(`動画のアップロードに失敗：${r.status}`);
  return c;
};
try {
  let c;
  if (e.種類 === "reel") c = await video(e.ファイル[0], { media_type: "REELS", caption, share_to_feed: "true" });
  else if (e.種類 === "carousel") {
    const kids = [];
    for (const f of e.ファイル) { const k = /\.mp4$/i.test(f) ? await video(f, { media_type: "VIDEO", is_carousel_item: "true" }) : await call("POST", `${ig}/media`, { image_url: raw(f), is_carousel_item: "true" }); await wait(k.id); kids.push(k.id); }
    c = await call("POST", `${ig}/media`, { media_type: "CAROUSEL", children: kids.join(","), caption });
  } else c = await call("POST", `${ig}/media`, { image_url: raw(e.ファイル[0]), caption });
  await wait(c.id);
  const pub = await call("POST", `${ig}/media_publish`, { creation_id: c.id });
  const info = await call("GET", pub.id, { fields: "permalink" });
  record("OK", info.permalink);
  console.log(`🎉 投稿しました：${info.permalink}`);
} catch (err) { record("失敗", err.message); console.log(`✖ 投稿に失敗：${err.message}`); process.exit(1); }
