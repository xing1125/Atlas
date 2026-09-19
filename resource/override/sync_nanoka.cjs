#!/usr/bin/env node
/*
 * sync_nanoka.cjs — 从 nanoka.cc 拉取 Atlas 缺图的图标，缓存进本地覆盖层。
 *
 * 设计原则（稳妥 / 双源结合）：
 *   - 听语惊花 Genshin-Atlas 镜像 = 唯一权威源，定期 `git pull` 即可更新，绝不手改。
 *   - nanoka.cc = 缺口补图源：当镜像没收新 7.0+ 内容时，用本脚本把图标拉来缓存进覆盖层。
 *   - 命令路径（atlas.js）只读 覆盖层 → 上游，完全本地、不碰网络；镜像保持纯净。
 *
 * 适用模块（对应 Genshin-Atlas/path.json 顶层键）：
 *   weapon / artifact / form / enemy / specialty / card / effect / material for role / food / up / material
 *   （角色立绘不归 Atlas 管，走 miao/genshin，本脚本不处理角色肖像）
 *
 * 用法（在 bot 本机运行，沙箱无外网）：
 *   node sync_nanoka.cjs --url https://gi.nanoka.cc/weapon/...      --name 白湖冬羽   --module weapon
 *   node sync_nanoka.cjs --url https://gi.nanoka.cc/character/10000140/ --name 沃迪娅尼察 --module "material for role"
 *   node sync_nanoka.cjs --img https://static.nanoka.cc/assets/gi/...webp --name XXX --module weapon
 *   --dry      只打印计划，不写文件 / 不下载
 *   --selftest 离线自测解析逻辑（不联网）
 *
 * 图标发现：抓取 nanoka 页面 HTML，提取所有 static.nanoka.cc/assets/gi/*.webp|png 与 og:image，
 *   按优先级挑选主图（角色页优先 og:image / 含角色 id 路径的静态图；武器页优先武器图标）。
 */

const fs = require('fs')
const path = require('path')

const OVERRIDE_DIR = __dirname                 // .../Atlas/resource/override
const PATH_JSON = path.join(OVERRIDE_DIR, 'path.json')

function parseArgs (argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([\w-]+)$/)
    if (!m) continue
    const k = m[1]
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    a[k] = v
  }
  return a
}

async function fetchText (u) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u)
  return r.text()
}
async function fetchBin (u) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + u)
  return Buffer.from(await r.arrayBuffer())
}

function extractImages (html) {
  const out = new Set()
  const ogRe = /<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/gi
  const ogRe2 = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/gi
  let m
  while ((m = ogRe.exec(html))) out.add(m[1])
  while ((m = ogRe2.exec(html))) out.add(m[1])
  const imgRe = /https:\/\/static\.nanoka\.cc\/assets\/gi\/[^\s"'<>()]+\.(?:webp|png|jpe?g)/gi
  while ((m = imgRe.exec(html))) out.add(m[0])
  return [...out]
}

function pickBest (urls, opts) {
  const id = opts.id
  // 1) 角色页：优先 og:image（通常是宣传立绘 / splash）
  if (opts.module === 'role' || opts.module === 'material for role') {
    const og = urls.find(u => /og:image|splash/i.test(u)) // og 已并入 urls
    if (og) return og
  }
  // 2) 含实体 id 路径的静态图（角色专属）
  if (id) {
    const hit = urls.filter(u => u.includes('/character/' + id + '/'))
    if (hit.length) return hit[0]
  }
  // 3) 偏好主图命名 side/icon/gacha/card/portrait
  const pref = urls.find(u => /\/(?:side|icon|gacha|card|portrait)\b/i.test(u))
  if (pref) return pref
  // 4) 第一个 static 资源兜底
  return urls.find(u => u.includes('static.nanoka.cc')) || null
}

function loadOverride () {
  return fs.existsSync(PATH_JSON) ? JSON.parse(fs.readFileSync(PATH_JSON, 'utf8')) : {}
}
function saveOverride (o) {
  fs.writeFileSync(PATH_JSON, JSON.stringify(o, null, 2) + '\n')
}
function normExt (u) {
  const m = u.match(/\.(webp|png|jpe?g)(\?|$)/i)
  return m ? m[1].toLowerCase().replace('jpg', 'jpeg') : 'webp'
}

async function run () {
  const a = parseArgs(process.argv.slice(2))

  if (a.selftest) return selftest()

  const dry = !!a.dry
  if (!a.url && !a.img) { console.error('需要 --url <nanoka页> 或 --img <图标直链>'); process.exit(1) }
  if (!a.name || !a.module) { console.error('需要 --name <本地显示名> --module <weapon|artifact|...>'); process.exit(1) }

  let imgUrl = a.img
  if (!imgUrl) {
    const html = await fetchText(a.url)
    const urls = extractImages(html)
    const id = (a.url.match(/character\/(\d+)/) || [])[1]
    imgUrl = pickBest(urls, { id, module: a.module })
    if (!imgUrl) {
      console.error('页面未解析到图标，候选:\n' + (urls.join('\n') || '(无)'))
      process.exit(2)
    }
    console.log('从页面解析到图标: ' + imgUrl)
  }

  const ext = normExt(imgUrl)
  const modDir = path.join(OVERRIDE_DIR, a.module)
  const fname = a.name + '.' + ext
  const dest = path.join(modDir, fname)
  const rel = '/' + a.module + '/' + fname

  const ov = loadOverride()
  ov[a.module] = ov[a.module] || {}
  if (ov[a.module][a.name] && fs.existsSync(dest) && !dry) {
    console.log('已存在，跳过: ' + rel)
    return
  }

  if (dry) {
    console.log(`[dry] 将下载 ${imgUrl}`)
    console.log(`[dry] 写到   ${dest}`)
    console.log(`[dry] 注册   override[${a.module}][${a.name}] = ${rel}`)
    return
  }

  fs.mkdirSync(modDir, { recursive: true })
  const buf = await fetchBin(imgUrl)
  if (buf.length < 500) throw new Error('下载文件过小（' + buf.length + ' bytes），可能不是图标')
  fs.writeFileSync(dest, buf)
  ov[a.module][a.name] = rel
  saveOverride(ov)
  console.log('已缓存: ' + rel + ' (' + buf.length + ' bytes)')
}

function selftest () {
  const html = `
    <meta property="og:image" content="https://static.nanoka.cc/assets/gi/character/10000140/gacha.webp" />
    <img src="https://static.nanoka.cc/assets/gi/Skill_S_Vodyanitsa_01.webp">
    <img src="https://static.nanoka.cc/assets/gi/Skill_E_Vodyanitsa_01.webp">
    <img src="https://static.nanoka.cc/assets/gi/Hydro.webp">
    <div style="background-image:url(https://static.nanoka.cc/assets/gi/character/10000140/side.webp)"></div>
  `
  const urls = extractImages(html)
  console.log('解析到的图标:')
  urls.forEach(u => console.log('  ' + u))
  const role = pickBest(urls, { id: '10000140', module: 'material for role' })
  const weapon = pickBest(urls, { id: null, module: 'weapon' })
  console.log('角色页优选(应=og:image gacha):', role)
  console.log('武器页优选(应=含id的side或首个static):', weapon)
  // 模拟合并
  const ov = loadOverride()
  ov['material for role'] = ov['material for role'] || {}
  ov['material for role']['沃迪娅尼察'] = '/material for role/沃迪娅尼察.webp'
  console.log('合并后 override 含 material for role 键:', 'material for role' in ov)
  console.log('SELFTEST OK')
}

run().catch(e => { console.error('失败: ' + e.message); process.exit(1) })
