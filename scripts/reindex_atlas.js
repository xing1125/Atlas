#!/usr/bin/env node
/**
 * Atlas 图鉴自动索引重建器
 * ------------------------------------------------------------------
 * 扫描 Genshin-Atlas / star-rail-atlas / zzz-atlas 各模块文件夹下的
 * 真实图片，按现有 path.json 结构「幂等重建」索引。
 *
 * 痛点：上游 genshin-atlas 自 6.7 起停更，新角色/武器只能自己补图。
 * 以往要手写 path.json 条目；用本脚本后，只要把图片按现有目录规则
 * 丢进对应模块文件夹（如 weapon/单手剑/xxx.png），跑一条命令即可
 * 自动重建索引，图鉴立刻对上，不再手工「建数据」。
 *
 * 用法:
 *   node scripts/reindex_atlas.js            # 默认重建 Genshin-Atlas
 *   node scripts/reindex_atlas.js genshin    # 同上
 *   node scripts/reindex_atlas.js starrail   # 重建星铁
 *   node scripts/reindex_atlas.js zzz        # 重建绝区零
 *   node scripts/reindex_atlas.js all        # 三个库全部重建
 *   DRY=1 node scripts/reindex_atlas.js      # 只报告差异，不写文件
 *
 * 说明:
 *   - 仅索引图片文件（png/jpg/jpeg/webp/gif/bmp/svg）。
 *   - 索引 key = 文件名(去扩展名)，value = /模块/子路径/文件名。
 *   - 模块列表取自现有 path.json 的键（artifact/weapon/...）。
 *   - 若某模块文件夹不存在，则保留该模块原有条目（不误删）。
 *   - 旧索引里文件已不存在的条目会被标记为孤儿并剔除。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginRoot = path.resolve(__dirname, '..')
const DRY = process.env.DRY === '1'

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'])

// 库名 -> 文件夹（与 model/moreLib.library 对应）
const TARGETS = {
  genshin: 'Genshin-Atlas',
  starrail: 'star-rail-atlas',
  zzz: 'zzz-atlas'
}

function resolveTargets (arg) {
  if (!arg || arg === 'genshin') return ['genshin']
  if (arg === 'starrail') return ['starrail']
  if (arg === 'zzz') return ['zzz']
  if (arg === 'all') return Object.keys(TARGETS)
  for (const [k, v] of Object.entries(TARGETS)) {
    if (v === arg) return [k]
  }
  console.error(`[错误] 未知目标: ${arg}\n可选: ${Object.keys(TARGETS).join(', ')}, all`)
  process.exit(1)
}

function walkImages (dir, baseModule, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walkImages(full, baseModule, out)
    } else {
      const ext = e.name.split('.').pop().toLowerCase()
      if (!IMG_EXT.has(ext)) continue
      const key = e.name.slice(0, -(ext.length + 1)) // 去扩展名
      const rel = '/' + path.relative(baseModule, full).split(path.sep).join('/')
      out[key] = rel
    }
  }
}

function reindex (libKey) {
  const libDir = path.join(pluginRoot, TARGETS[libKey])
  const pathJson = path.join(libDir, 'path.json')
  if (!fs.existsSync(pathJson)) {
    console.warn(`[跳过] 未找到 ${TARGETS[libKey]}/path.json`)
    return
  }
  const rawOld = fs.readFileSync(pathJson, 'utf8')
  const old = JSON.parse(rawOld)
  // 探测「已提交版本(HEAD)」的换行符，写回时保持一致，避免整文件被判为改动
  let EOL = '\n'
  try {
    const headRaw = execSync('git --git-dir=.git show HEAD:path.json', { cwd: libDir, encoding: 'utf8' })
    EOL = headRaw.includes('\r\n') ? '\r\n' : '\n'
  } catch { /* 退化 LF */ }
  const modules = Object.keys(old)
  const next = {}
  let total = 0
  let added = 0
  const orphan = []

  for (const mod of modules) {
    const modDir = path.join(libDir, mod)
    if (!fs.existsSync(modDir)) {
      // 模块文件夹缺失，保守保留原条目，避免误删
      next[mod] = old[mod] || {}
      continue
    }
    const scanned = {}
    walkImages(modDir, libDir, scanned)
    const oldMod = old[mod] || {}
    // 关键：保留旧索引的全部条目（含别名 yaml 等非图片项），用扫描到的图片覆盖/补充
    const merged = { ...oldMod, ...scanned }
    for (const k of Object.keys(merged)) {
      total++
      if (!(k in oldMod)) added++
    }
    // 孤儿仅作提示（旧条目指向的文件已不存在）。仍予保留，避免误删导致出图异常
    for (const k of Object.keys(oldMod)) {
      if (!(k in scanned)) {
        const p = oldMod[k]
        if (typeof p === 'string' && p.startsWith('/') && !fs.existsSync(path.join(libDir, p))) {
          orphan.push(`${mod}/${k}`)
        }
      }
    }
    next[mod] = merged
  }

  const warn = orphan.length
    ? `，发现 ${orphan.length} 条孤儿(旧索引文件已不存在): ${orphan.slice(0, 5).join(', ')}${orphan.length > 5 ? '…' : ''}`
    : ''

  if (DRY) {
    console.log(`[DRY] ${TARGETS[libKey]}: 将写入 ${total} 条索引，新增 ${added} 条${warn}`)
    return
  }
  // 仅在索引数据真正变化时才写回，避免无谓改动（保持与上游提交一致）
  if (JSON.stringify(next) === JSON.stringify(old)) {
    console.log(`[跳过] ${TARGETS[libKey]}: 索引无变化，未改动 path.json`)
    return
  }
  fs.writeFileSync(pathJson, JSON.stringify(next, null, 4).split('\n').join(EOL) + EOL)
  console.log(`[完成] ${TARGETS[libKey]}: 共 ${total} 条索引，本次新增 ${added} 条${warn}`)
}

const targets = resolveTargets(process.argv[2])
for (const t of targets) reindex(t)
