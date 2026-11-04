# dsh-wechat-send

给 DSH 加一个 `wechat_send` 工具：**让 agent 给微信好友发文字，全程不用打字。**

```
wechat_send({ to: "宋紫秦", text: "随机抽查：今天有没有好好吃饭？😄" })
```

一条命令，约 10 秒发出，不需要打开输入框、不需要输入法。

---

## 为什么是这么做

微信屏蔽了无障碍树（`screen` 永远返回 0 个元素），所以：

- 点按钮 → 只能截图 + OCR + 按坐标点；
- 打字 → 不可能（没有元素可以 setText，也没有输入法注入）。

于是绕开输入框，走**系统分享**通道：

```
ACTION_SEND 文本 → 微信「发送给朋友」→「选择一个聊天」→ 点联系人 → 点「发送」
```

每一步都是「截图 → tesseract 识别 → 坐标点击」，全程不碰输入框。

## 安装

依赖（缺一不可）：

```bash
# Ubuntu / PRoot
apt-get install -y tesseract-ocr tesseract-ocr-chi-sim python3-pil
```

放到 DSH 的插件目录：

```bash
mkdir -p ~/.dsh/dsh-go/plugins/wechat-send/lib
# 把 package.json / cordis.patch.yml / lib/index.js / lib/ocr.py 放进去
dsh plugin --profile web add ~/.dsh/dsh-go/plugins/wechat-send
```

重启引擎后，模型就多了一个 `wechat_send` 工具。

> 手机桥的路径是 `/opt/dsh-app/phone/relay.cjs` + `/var/lib/dsh-app/phone/bridge.json`，
> 这是 DSH Go App 写入的，不用改。换 App 版本时如果路径变了，改 `lib/index.js` 顶部的
> `RELAY` / `BRIDGE` 两个常量。

## 换一台手机怎么调

不同手机、不同微信版本，界面尺寸、字体、按钮位置都不一样。**先跑一次，看报错信息里列出的
OCR 文本**，再改 `lib/index.js` 顶部的 `CONFIG`：

| 现象 | 改什么 |
|---|---|
| 点不到「最近聊天」列表里的名字 | `listMinX`（名字起始 x，往右移就加大，跳过头像） |
| 名字后面还有一截，匹配不上 | 列表行会带时间/摘要，代码只取前两个字做包含匹配；名字特别短就把 `pairs` 改成整名 |
| 点「发送」没反应 | `confirmSendRatio`（确认页按钮的相对位置，默认 0.66 / 0.9） |
| 分享面板半天不出来 | `shareWaitMs` 加大到 1800 |
| 点完没生效 | `tapWaitMs` 加大到 900 |
| OCR 全是乱码 | `ocrLang` 换成别的语言包，或先跑 `tesseract --list-langs` 确认 `chi_sim` 装了 |

**屏幕比例**：代码里所有坐标都是「截图原始像素」，桥返回的截图多大就用多大，不需要按 dp 换算。
`confirmSendRatio` 是唯一的相对比例，屏占比不同的手机可能需要 ±0.03 的微调。

**微信版本差异**：

- 首次分享会多一层「发送给朋友 / 添加到微信收藏」的选择框（两个按钮常被 OCR 粘成一行，代码点左半边）；
- 老版本没有这层，代码会跳过；
- 发完有个「已发送 / 返回第三方工具 / 留在微信」的弹窗，代码会点「留在微信」，没有就跳过。

## 已知限制（重要）

- **收件人核对靠「列表里只有一行匹配」**，不靠确认页那行小字（OCR 把小字认成「宁紫奉」这种事常有）。
  所以：名字太短或列表里有两个相似名字时，会**主动中止**而不是猜。
- 不要在人正用手机的时候跑：它会点屏幕上的坐标，点错地方很危险。
- 长消息：微信对单条文本有长度上限，几千字符的代码建议分成几条发，或者直接发链接。
- 只能发文字，发不了图片/文件。

## 实测

- 机型：Android（PRoot Ubuntu 24.04，DSH Go）
- 微信版本：8.x
- 单条发送：约 10 秒（3 次 OCR，每次 1.2 秒）

## License

MIT
