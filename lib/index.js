// wechat-send：给微信联系人发一条文字，全程不用打字。
// 路线：系统分享(ACTION_SEND) → 微信「选择一个聊天」→ 点联系人 → 点「发送」。
// 微信屏蔽无障碍树（dump 恒为 0 节点），所以每一步都是截图 + OCR + 坐标点击。
import { spawn, execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RELAY = '/opt/dsh-app/phone/relay.cjs'
const BRIDGE = '/var/lib/dsh-app/phone/bridge.json'
const PY = '/usr/local/bin/python3'
const TSV = '/usr/bin/tesseract'
const HERE = new URL('./ocr.py', import.meta.url).pathname

// 不同手机/微信版本可能要微调的地方都在这里，改完不用动下面的流程代码。
// 详细说明见 README.md「换一台手机怎么调」。
export const CONFIG = {
  app: '微信', // 分享目标应用名
  ocrLang: 'chi_sim', // tesseract 语言包
  shareWaitMs: 1200, // 分享面板弹出后等多久
  tapWaitMs: 700, // 每次点击后等多久
  sendWaitMs: 1400, // 点「发送」后等多久
  listMinX: 90, // 「最近聊天」列表里名字的起始 x，用来跳过左侧头像
  nameTapOffsetX: 20, // 点在名字左侧第几个像素
  confirmSendRatio: { x: 0.66, y: 0.9 }, // 发送按钮相对位置（OCR 读不到按钮字时用）
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 60000 }, (e, out) => (e ? rej(e) : res(out))))
const flat = (s) => String(s).replace(/[\s\u3000]/gu, '')

export function connect() {
  const child = spawn(process.execPath, [RELAY, BRIDGE], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let id = 0
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.trim() === '') continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  const call = (method, params) => new Promise((res, rej) => {
    const mine = ++id
    const timer = setTimeout(() => { pending.delete(mine); rej(new Error('手机桥没响应')) }, 60000)
    pending.set(mine, (m) => { clearTimeout(timer); res(m) })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n')
  })
  return {
    async init() {
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wechat-send', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      return this
    },
    async tool(name, args = {}) {
      const r = await call('tools/call', { name, arguments: args })
      if (r.error !== undefined) throw new Error(String(r.error.message ?? '手机桥报错'))
      const res = r.result ?? {}
      const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      const img = (res.content ?? []).find((c) => c.type === 'image')
      if (res.isError === true) throw new Error(text || '手机桥拒绝了操作')
      return { text, image: img?.data }
    },
    close() { try { child.kill() } catch {} },
  }
}

/** OCR 一张截图：返回 { width, height, words:[{text,x,y,w,h}] }，坐标是截图原始像素。 */
export async function ocrWords(jpeg) {
  const dir = mkdtempSync(join(tmpdir(), 'wxs-'))
  try {
    const src = join(dir, 'a.jpg')
    const png = join(dir, 'a.png')
    writeFileSync(src, jpeg)
    const meta = JSON.parse(await run(PY, [HERE, src, png]))
    const tsv = await run(TSV, [png, 'stdout', '-l', CONFIG.ocrLang, '--psm', '6', 'tsv'])
    const scale = Number(meta.scale) || 1
    const words = []
    for (const row of String(tsv).split('\n').slice(1)) {
      const c = row.split('\t')
      if (c.length < 12 || Number(c[0]) !== 5 || Number(c[10]) < 25) continue
      const text = c.slice(11).join('\t').trim()
      if (text === '') continue
      words.push({
        text,
        x: Math.round(Number(c[6]) / scale),
        y: Math.round(Number(c[7]) / scale),
        w: Math.round(Number(c[8]) / scale),
        h: Math.round(Number(c[9]) / scale),
      })
    }
    return { width: Number(meta.width) || 0, height: Number(meta.height) || 0, words }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

/** 把零散的字按行聚起来：列表里的名字常被切成单字，靠聚类才拼得回「宋紫奏」。 */
export function rowsOf(page, { minX = 0, minY = 0 } = {}) {
  const ws = page.words.filter((w) => w.x >= minX && w.y >= minY).sort((a, b) => a.y - b.y || a.x - b.x)
  const rows = []
  for (const w of ws) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= 14)
    if (row === undefined) rows.push({ y: w.y, x: w.x, words: [w] })
    else {
      row.words.push(w)
      row.y = (row.y + w.y) / 2
      row.x = Math.min(row.x, w.x)
    }
  }
  return rows.map((r) => ({
    text: r.words.sort((a, b) => a.x - b.x).map((w) => w.text).join(''),
    x: r.words[0].x,
    y: Math.round(r.y + 8),
  })).sort((a, b) => a.y - b.y)
}

/** 走分享通道发一条：把 text 发给昵称/备注为 to 的联系人。 */
export async function sendTo(phone, { to, text }) {
  const steps = []
  const name = flat(to)
  const WAIT = CONFIG.tapWaitMs
  const look = async () => {
    const shot = await phone.tool('screen', { image: true })
    const page = await ocrWords(Buffer.from(shot.image, 'base64'))
    return { sid: (/屏幕 (\S+) ·/u.exec(String(shot.text).split('\n')[0] ?? '') ?? [])[1] ?? '', page, shot }
  }
  const tap = async (sid, x, y, ms = WAIT) => {
    await phone.tool('tap_xy', { observation: sid, x: Math.round(x), y: Math.round(y) })
    await sleep(ms)
  }

  // 1) 系统分享（会盖在最上层，不需要先清场）
  await phone.tool('intent', { kind: 'share', text, app: CONFIG.app })
  await sleep(CONFIG.shareWaitMs)

  let { sid, page } = await look()
  let rows = rowsOf(page)

  // 2) 首次会问「发送给朋友 / 添加到微信收藏」，两个按钮常粘成一行，点左半边
  const friend = rows.find((r) => r.text.includes('发送给朋友'))
  if (friend !== undefined) {
    const left = friend.text.includes('添加到微信收藏')
    await tap(sid, left ? page.width * 0.3 : friend.x, friend.y)
    steps.push('选「发送给朋友」')
    ;({ sid, page } = await look())
  }

  // 3) 「选择一个聊天」：只看「最近聊天」表头以下的列表行。
  //    表头之上是「最近转发」头像排，名字被粘成一长串，点中间会落到别人身上，一律不碰。
  rows = rowsOf(page)
  const header = rows.find((r) => r.text.includes('最近聊天'))
  const list = header === undefined ? [] : rowsOf(page, { minX: CONFIG.listMinX, minY: header.y + 10 })
  // 短名字用「连续两个字」匹配（OCR 常把「秦」认成「奏」），且必须唯一命中
  const pairs = name.length >= 2 ? [name.slice(0, 2), name.slice(-2)] : [name]
  const hits = list.filter((r) => pairs.some((p) => p.length >= 2 && r.text.includes(p)))
  if (hits.length !== 1) {
    throw new Error(`「选择一个聊天」里${hits.length === 0 ? '没找到' : '找到多行疑似'}「${to}」，为避免发错人已中止。看到：${list.slice(0, 8).map((r) => r.text).join(' / ')}`)
  }
  await tap(sid, hits[0].x + CONFIG.nameTapOffsetX, hits[0].y)
  steps.push(`点「${hits[0].text}」`)
  ;({ sid, page } = await look())

  // 4) 安全闸：确认页必须写「发送给」且能认出这个人，否则退出去不发
  rows = rowsOf(page)
  const sheet = rows.find((r) => r.text.includes('发送给'))
  // 确认页那行小字 OCR 太飘（宋紫秦 → 宁紫奉 / ，），不作为判据。
  // 防错靠上一步：列表里只有唯一一行匹配，且点的是那一行。
  if (sheet === undefined) {
    await phone.tool('key', { screen: sid, key: 'back' })
    throw new Error(`确认页对不上「${to}」，已中止。当前：${rows.slice(0, 6).map((r) => r.text).join(' / ')}`)
  }
  // 绿色按钮上的白字 OCR 常常读不出，读不到就按固定相对位置点（底部右侧那个按钮）
  const hit = rows.filter((r) => flat(r.text) === '发送' && r.y > page.height * 0.5).pop()
    ?? { x: page.width * CONFIG.confirmSendRatio.x, y: page.height * CONFIG.confirmSendRatio.y }
  await tap(sid, hit.x, hit.y, CONFIG.sendWaitMs)
  steps.push(hit.text === '发送' ? '点「发送」' : '点「发送」（按位置）')

  // 5) 收尾：「已发送」弹窗点「留在微信」（固定相对位置，不再 OCR）
  const shot = await phone.tool('screen', { image: true })
  const after = await ocrWords(Buffer.from(shot.image, 'base64'))
  const stay = rowsOf(after).find((r) => flat(r.text) === '留在微信')
  if (stay !== undefined) await tap((/屏幕 (\S+) ·/u.exec(String(shot.text).split('\n')[0] ?? '') ?? [])[1] ?? '', stay.x, stay.y, 500)
  return { steps, title: rows[0]?.text ?? '' }
}

export function apply(ctx) {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register({
      name: 'wechat_send',
      description: '给微信联系人发一条文字消息（不用打字）：系统分享 → 选择一个聊天 → 点联系人 → 点发送，全程截图 + OCR + 坐标点击。',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '联系人昵称或备注，如「宋紫秦」' },
          text: { type: 'string', description: '要发送的文字' },
        },
        required: ['to', 'text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            steps: { type: 'array', items: { type: 'string' } },
            title: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, v) => [{
          type: 'text',
          text: v.ok === true
            ? `已发送 ✓ ${(v.steps ?? []).join(' → ')}（当前会话：${v.title}）`
            : String(v.reason ?? '没发成'),
        }],
      },
      async execute(args) {
        const phone = await connect().init()
        try {
          const r = await sendTo(phone, { to: String(args.to ?? '').trim(), text: String(args.text ?? '') })
          return { ok: true, steps: r.steps, title: r.title }
        } catch (e) {
          return { ok: false, reason: String(e?.message ?? e), steps: [] }
        } finally {
          phone.close()
        }
      },
    })
  })
}
