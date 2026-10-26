import { pluginResources } from "./model/path.js";
import path from 'path'
import fs from 'node:fs'
import YAML from 'yaml'

// 配置复用插件自身读写位置：resource/config.yaml（缺省由 config_default.yaml 复制而来）
const CONFIG_FILE = path.join(pluginResources, 'config.yaml')
const DEFAULT_FILE = path.join(pluginResources, 'config_default.yaml')

function readCfg() {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(DEFAULT_FILE)) {
    try { fs.copyFileSync(DEFAULT_FILE, CONFIG_FILE) } catch { /* ignore */ }
  }
  try {
    return YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

/** 写回时优先用 parseDocument 保留原文件里的中文注释，失败才退回 stringify */
function writeCfg(obj) {
  try {
    const doc = YAML.parseDocument(fs.readFileSync(CONFIG_FILE, 'utf8'))
    for (const [k, v] of Object.entries(obj)) doc.set(k, v)
    fs.writeFileSync(CONFIG_FILE, doc.toString())
  } catch {
    fs.writeFileSync(CONFIG_FILE, YAML.stringify(obj))
  }
}


// 支持锅巴
export function supportGuoba () {
  return {
    pluginInfo: {
      name: 'atlas',
      title: '图鉴(Atlas)',
      author: '@听语惊花',
      authorLink: 'https://github.com/Nwflower',
      link: 'https://github.com/Nwflower/atlas',
      isV3: true,
      isV2: false,
      description: '一个Yunzai-Bot的原神图鉴拓展插件',
      icon: 'iconoir:3d-three-pts-box',
      iconColor: '#f4c436',
      iconPath: path.join(pluginResources, 'img/logo_atlas.png'),
    },
    configInfo: {
      schemas: [
        {
          field: 'priority',
          label: '插件优先级',
          bottomHelpMessage:
            '数值越小越优先响应（Yunzai 惯例）。与逍遥插件并存时用默认值 10 即可；改动需重启/重载 Yunzai 生效。',
          component: 'InputNumber',
          required: true,
          componentProps: { min: 1, max: 9999, placeholder: '10' },
        },
        {
          field: 'success',
          label: '拦截指令（不再传递给逍遥插件）',
          bottomHelpMessage:
            '开启(TRUE)后，Atlas 匹配到的图鉴指令处理完即结束，不再继续传给逍遥插件执行；关闭(FALSE)则两边都会响应。改动需重启/重载生效。',
          component: 'Switch',
        },
      ],
      getConfigData() {
        return readCfg()
      },
      setConfigData(data, { Result }) {
        const cur = readCfg()
        writeCfg({ ...cur, ...data })
        return Result.ok({}, '保存成功~（改动需重启/重载 Yunzai 生效）')
      },
    },
  }
}
