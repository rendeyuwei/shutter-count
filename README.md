# ShutterCount · 相机快门次数查询

上传一张相机直出的 JPG 原图，即可读取其快门次数（EXIF + 厂商 MakerNotes，经 ExifTool 解析）。

- 线上地址：<https://rende.fun/shutter>
- 图片仅在解析期间写入临时目录，解析完成后立即删除，**不落盘、不持久化**。
- 前端为纯静态页面（无构建步骤），后端为单个 Fastify 服务。

## 技术栈

| 组件 | 说明 |
| --- | --- |
| Node.js | ≥ 20（ESM） |
| Fastify 5 | HTTP 服务框架 |
| exiftool-vendored | 内置 ExifTool 二进制，解析 EXIF / MakerNotes |
| @fastify/multipart | 上传处理（流式写临时文件） |
| @fastify/static | 托管 `public/` 静态前端（无构建） |
| @fastify/rate-limit | 解析接口限流（默认 30 次/分钟/IP） |

## 本地运行

要求：Node.js ≥ 20。

```bash
npm install
npm start
```

默认监听 <http://127.0.0.1:3020/shutter/>（`GET /shutter` 会 308 跳转到 `/shutter/`）。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3020` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（仅本机；对外由 nginx 反代） |
| `BASE_PATH` | `/shutter` | 应用挂载路径前缀 |
| `MAX_UPLOAD_MB` | `50` | 单文件上传上限（MB），超限返回 `file_too_large` |
| `TRUST_PROXY` | `127.0.0.1,::1` | Fastify `trustProxy`：`true`/`false` 或逗号分隔的 IP/CIDR 列表；默认仅信任本机回环（nginx 同机反代），防止伪造 `X-Forwarded-For` 绕过限流 |

## 测试

```bash
npm test
```

使用 Node 内置 test runner（`node --test test/`），覆盖服务器路由、上传校验与厂商标签映射。

### 冒烟测试（针对运行中的实例）

```bash
npm run smoke -- [baseUrl] file1.jpg [file2.jpg ...]
```

- `baseUrl` 可省略，默认 `http://127.0.0.1:3020/shutter`。
- 依次检查：首页返回 200 HTML、`/api/health` 返回 200，然后逐个上传 JPG 并打印 `status / model / shutterCount / capturedAt`。
- 页面或健康检查失败、或任一请求返回 5xx 时退出码非零。

## API

所有接口挂在 `BASE_PATH`（默认 `/shutter`）下。

### `GET /shutter/api/health`

返回 `{ "status": "ok", "exiftool": "<版本号>" }`；ExifTool 不可用时返回 500 `{ "status": "error" }`。

### `POST /shutter/api/parse`

- 请求：`multipart/form-data`，字段名 **`file`**，仅接受 JPG/JPEG（校验扩展名 + `FF D8 FF` 魔术字节）。
- 限流：默认每 IP 30 次/分钟，超限返回 429 `{ "status": "rate_limited" }`。

响应 `status` 取值：

| status | HTTP 码 | 含义 |
| --- | --- | --- |
| `ok` | 200 | 成功读到快门次数，返回 `shutterCount`、`shutterSource`、`make`、`model`、`approximate`、`note`、`capturedAt` |
| `no_shutter_field` | 200 | 图片有效，但该机型的 MakerNotes 中没有可用的快门类字段 |
| `unsupported_or_corrupt` | 422 | 非 JPEG、文件损坏或 ExifTool 无法解析（`reason` 说明原因） |
| `file_too_large` | 413 | 超过 `MAX_UPLOAD_MB`（响应含 `maxMb`） |
| `bad_request` | 400 | 缺少上传文件（表单字段 `file`） |

成功示例：

```json
{
  "status": "ok",
  "make": "NIKON CORPORATION",
  "model": "Nikon D750",
  "shutterCount": 12345,
  "shutterSource": "Nikon:ShutterCount",
  "approximate": false,
  "note": null,
  "capturedAt": "2024-05-01 12:34:56"
}
```

## 支持的品牌与标签优先级

快门次数只从**厂商自身的 MakerNotes 组**中读取，按下列优先级依次尝试；候选值必须是 0 < n ≤ 5,000,000 的整数（超出视为脏数据，跳到下一候选）：

| 品牌 | 标签优先级 | 备注 |
| --- | --- | --- |
| Nikon | `ShutterCount` → `MechanicalShutterCount` | |
| Canon | `ShutterCount` → `ImageCount` | `ImageCount` 为近似值：格式化存储卡后可能归零 |
| Sony | `ShutterCount` → `ShutterCount2` → `ShutterCount3` | |
| FUJIFILM | `ImageCount` | 近似值：拍摄计数（含电子快门），固件升级后可能归零 |
| PENTAX | `ShutterCount` | 含 Ricoh Imaging / Asahi 机身上报 |
| OLYMPUS | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | 含 OM Digital / OM System；有则读取 |
| Panasonic | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | 有则读取 |

未收录的品牌会做通用兜底：读取任意 MakerNotes 组中的 `ShutterCount` 标签。

## 生产部署概要

部署在 rende.fun 所在服务器，路径与进程约定如下：

- 目录布局：`/opt/shutter-count/releases/<id>/` + `/opt/shutter-count/current` 软链指向当前版本（入口对软链安全，Node realpath 解析已处理）。
- 进程管理：PM2，应用名 **`shutter-count`**（配置见 `ecosystem.config.cjs`，可用 `SHUTTER_APP_DIR` 指定发布目录，便于软链切换时不中断管理）。
- 端口：**3020**，仅监听 `127.0.0.1`。
- nginx：`snippets/shutter-locations.conf` 以 `include` 方式并入 rende.fun 站点配置，将 `/shutter` 反代到本机 3020；**勿动 easypic** 相关的既有配置。

常用命令：

```bash
pm2 start ecosystem.config.cjs   # 首次
pm2 reload shutter-count         # 发布后切换软链再重载
pm2 logs shutter-count
```

## 隐私

- 上传文件写入系统临时目录下前缀为 `shuttercount-` 的独立子目录，解析完成后**在响应发出前立即删除**。
- 服务启动时会尽力清理崩溃残留的、超过 10 分钟的 `shuttercount-*` 临时目录。
- 不持久化任何图片：不入库、不留档；日志只记录状态码与耗时，绝不记录文件内容或元数据。
- 错误响应不暴露堆栈、文件内容或元数据。
