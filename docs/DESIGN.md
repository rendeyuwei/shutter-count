# ShutterCount UI 设计说明

产品地址（规划）：https://rende.fun/shutter  
视觉基准：EasyPic（https://rende.fun/easypic/）暗色主题，同色板 / 字族 / 圆角 / 上传居中卡片。

静态原型：`/workspace/shutter-ui/index.html`（单页 + 顶栏 Tab 切换状态，便于截图）。

---

## 设计系统（CSS 变量）

| Token | 值 |
| --- | --- |
| `--bg` | `#0c0d0f` |
| `--surface` | `#141619` |
| `--surface-raised` | `#1b1e22` |
| `--surface-soft` | `#23272c` |
| `--text` | `#f4f3ef` |
| `--text-muted` | `#a6a8a9` |
| `--border` | `rgb(255 255 255 / 10%)` |
| `--border-strong` | `rgb(255 255 255 / 18%)` |
| `--accent` | `#efac4b` |
| `--accent-hover` | `#f6bb63` |
| `--accent-text` | `#1c1308` |
| `--danger` | `#ff8f82` |
| 圆角 | 10 / 16 / 24px |
| 字族 | Inter, ui-sans-serif, system-ui |
| 卡片最大宽 | ~630px（与 EasyPic upload-card 一致） |

页面背景：`--bg` + 左上角轻微 accent 径向光晕（同 EasyPic）。

---

## 布局骨架

所有主状态共用 **居中上传屏**：

1. **Brand mark**：`SC`，44×44 圆角方块，accent 底 + accent-text 字（对应 EasyPic 的 `EP`）
2. **Eyebrow**：`ShutterCount`（accent、字距 0.16em、大写）
3. **H1**：`查看相机快门次数`
4. **Intro**：一句说明（按状态微调）
5. **主体区**：dropzone / 结果卡 / 警告条
6. **隐私注**：盾牌图标 +「图片仅临时解析，不长期保存」

截图时可用原型顶栏 Tab 隐藏或裁掉；产品页面不保留那套原型 chrome。线上页面在 `<head>` 加载共享顶栏 `/shell/topbar.js`。顶栏固定在视口顶部，高度是 `--rf-h`（没有顶栏时按 0）。页面没有自己的 fixed 或 sticky 元素；`body` 用 `padding-top: var(--rf-h, 0px)` 留出位置，上传屏高度为 `calc(100dvh - var(--rf-h, 0px))`。

中文页是 `{BASE_PATH}/`，英文页是 `{BASE_PATH}/en/`。卡片右上角有语言开关；共享顶栏初次提供的语言就是本页另一种语言时，页内开关隐藏，并且这一枚顶栏开关会跟着内存切换和前进后退更新。顶栏其余文字等外壳自己刷新。图标、样式和脚本使用挂载绝对路径。中文缺失帮助使用未裁剪原截图。英文使用整张英文示意图，并注明 English illustration。已有结果时切换语言不重新上传。解析进行中不会自己改语言。

---

## 文案与状态

### 1. 上传（空态）

- Intro：`上传一张相机原图，读取机身与快门计数。`
- Dropzone 主文：`点击或拖放原图到这里`
- Dropzone 副文：`支持 JPG、JPEG，建议相机直出原图`
- 隐私：`图片仅临时解析，不长期保存`
- 交互：虚线边框、hover / drag 时边框变 accent、轻微上浮

### 2. 成功

- Intro：`已从原图中读取到机身与快门信息。`
- 文件 chip：文件名（示例 `DSC_2480.JPG`）
- 结果卡三行：
  - **机身型号** — 常规字重（示例 `Nikon Z6 II`）
  - **快门次数** — 大号 accent 数字（示例 `12,480`）
  - **拍摄时间** — 常规（示例 `2025-11-03 14:22:08`）
- 主按钮（accent）：`再查一张`

### 3. 读不到快门

- Intro：`已解析元数据，但未能读到快门计数。`
- 文件 chip：仍显示文件名
- 一块失败帮助卡，只出现在这一状态。换文件、成功、其他错误或回到上传页时，舞台整体替换，帮助不保留。页面不展示请求 ID、状态码、原因或复制诊断。
  - 标题：`未能读取快门次数`
  - 两类原因：相机或该文件可能不提供；也可能在编辑、导出或分享时丢失。
  - 小标题：`iPhone 用户可尝试`
  - 步骤：在照片中选中、点击分享、选择「导出未修改的原片」、保存后重新上传。
  - 限定：原片也不保证一定能查到，仍取决于相机是否记录了可读取的快门次数。
  - 完整截图按比例缩放，卡内有「查看大图」，点击后在新页面打开原图。
- English: this state is one help card. It names the two possible causes, lists the iPhone steps for Export Unmodified Original, and says an original may still lack a readable count. The picture is the full English illustration, with that caption, and opens full size. The page does not show request IDs or diagnostic text.
- 结果卡：有则展示 **机身型号**、**拍摄时间**（无快门行；示例 Sony ILCE-7M4）
- 次按钮（secondary）：`重新上传`

### 4. 解析中（可选）

- 同一 dropzone 区域：`aria-busy`，旋转 spinner
- 主文：`正在解析原图…`
- 副文：文件名 + `请稍候`
- 隐私注保留

---

## 组件备注

- **主按钮**：accent 底、`--accent-text` 字、圆角 10px、min-height 44px
- **次按钮**：`--surface-soft` 底 + border
- **结果卡**：`--surface-raised`、1px border、大阴影；行间用 border 分隔；标签 12px muted 大写
- **文件 chip**：胶囊形、左侧文件图标
- **警告条**：勿用实心大红块；用 soft danger（约 10% danger 混入 surface）

---

## 响应式

- 移动优先；卡片 `width: min(100%, 630px)`
- H1 用 `clamp(32px, 6vw, 54px)`
- 快门数字 `clamp(36px, 8vw, 52px)`
- safe-area padding，与 EasyPic upload-screen 一致

---

## 如何预览 / 截图

```bash
npm ci
npm run build
npm start
```

使用实际页面预览：`http://127.0.0.1:3020/shutter/?demo#success`。
支持 `#success`、`#fail`、`#error`、`#loading`；上传状态使用 `/shutter/`。
原 `docs/prototype.html` 已退役，设计预览与生产页面共用 TypeScript 实现。
开发时可另开 `npm run dev:web` 使用 Vite；真实原图上传需要后端同时运行。
