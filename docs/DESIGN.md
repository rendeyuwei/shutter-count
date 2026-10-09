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

截图时可用顶栏 Tab 隐藏或裁掉；产品上线不保留该 chrome。

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
- 软警告条（danger 浅底 + 边框）：
  - 标题：`未能读到快门次数`
  - 正文：`该型号原图可能不含快门信息，或请换一张相机直出的原图再试。`
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
# 本机直接打开
open /workspace/shutter-ui/index.html
# 或任意静态服务器，例如：
# python3 -m http.server 8765 --directory /workspace/shutter-ui
```

顶栏切换：**上传** / **成功** / **读不到** / **解析中**  
也可用锚点：`#upload` `#success` `#fail` `#loading`
