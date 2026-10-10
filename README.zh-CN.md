# ShutterCount · 相机快门次数查询

[English](README.md) | [简体中文](README.zh-CN.md)

上传一张相机直出的 JPG/JPEG 原图，通过 ExifTool 解析 EXIF 和厂商 MakerNotes，读取快门次数。

- 项目地址：<https://rende.fun/shutter>
- 使用 Vite 构建的 TypeScript 前端入口，后端为单个 Fastify 服务。
- 图片在解析期间写入临时目录，应用会在发送响应前尝试删除该目录；不建立图片档案，也不将图片存入数据库。
- 读取失败时可复制诊断信息，让运维人员不依赖原图也能查到对应的服务端日志。

## 技术栈与目录

| 组件 | 用途 |
| --- | --- |
| Node.js ≥ 22.12 | ESM 运行环境 |
| TypeScript / Vite | 全项目严格检查与前端构建 |
| Fastify 5 | HTTP 服务 |
| `exiftool-vendored` | 内置 ExifTool，解析 EXIF / MakerNotes |
| `@fastify/multipart` | 流式上传到临时文件 |
| `@fastify/static` | 托管编译后的 `dist/public/` 资源 |
| `@fastify/rate-limit` | 解析接口默认限流：每 IP 每分钟 30 次 |

- `web/`：浏览器 TypeScript 与 HTML；`public/`：样式与静态资源
- `shared/`：带类型的结果契约
- `src/app.ts`：路由、上传校验、请求 ID、日志及临时文件清理
- `src/parse.ts`：ExifTool 生命周期与解析
- `src/mapping.ts`：相机品牌识别和快门标签优先级
- `test/`：服务端、解析、映射和诊断回归测试；JPEG 样本说明见 [test/fixtures/README.md](test/fixtures/README.md)
- `scripts/smoke.ts`：针对运行中实例的冒烟测试
- `ecosystem.config.cjs` / `bin/start.mjs`：PM2 配置与进程管理器显式启动入口
- `docs/`：[产品需求](docs/PRD-shutter.md)与 [UI 设计](docs/DESIGN.md)
- `tools/build.ts` / `dist/`：构建编排及忽略的运行产物

[全项目现代化方案](docs/MODERNIZATION.zh-CN.md)覆盖前后端、共享协议、Node 工具、启动逻辑与全部测试。四个阶段已在本地完成，源码统一严格 TypeScript，编译产物位于 `dist/`。

## 本地运行

要求 Node.js ≥ 22.12。

```bash
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:3020/shutter/>。`GET /shutter` 会以 HTTP 308 跳转到 `/shutter/`。

`npm run dev:server` 使用 tsx 监听后端源码。在第二个终端运行 `npm run dev:web` 启动 Vite，将 `/api` 代理到默认本地后端的 `/shutter/api`。生产启动直接运行编译文件，不依赖开发依赖。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3020` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；默认通过本机反向代理对外提供服务 |
| `BASE_PATH` | `/shutter` | 应用路径前缀；设置为 `/` 可挂载到根路径 |
| `MAX_UPLOAD_MB` | `50` | 服务端上传上限，每单位为 1,048,576 字节；超限返回 `file_too_large` |
| `MAX_ACTIVE_UPLOADS` | `2` | 同时执行上传、解析和清理的数量 |
| `MAX_WAITING_UPLOADS` | `8` | 等待队列上限 |
| `QUEUE_WAIT_MS` | `5000` | 最长等待时间（毫秒），超出返回 503 / `busy` |
| `REQUEST_TIMEOUT_MS` | `60000` | HTTP 请求接收超时（毫秒） |
| `TRUST_PROXY` | `127.0.0.1,::1` | Fastify `trustProxy`：`true`、`false` 或逗号分隔的 IP/CIDR 列表 |

默认仅信任本机回环代理，例如同机 nginx。应根据实际代理拓扑设置 `TRUST_PROXY`；信任任意客户端可能使其伪造 `X-Forwarded-For`，绕过每 IP 限流。

浏览器通过 `GET /api/config` 读取有效上传限制，与服务端字节上限一致；配置读取失败时可重试，恢复前不会上传。非法端口、路径、大小和代理配置会阻止启动。

## 测试

```bash
npm test
npm run typecheck
npm run format:check
npm run test:browser
```

使用 Node 内置 test runner 运行 `dist/test/` 下编译后的测试。`npm test` 先构建；`npm run test:built` 复用完成的构建。构建后可用 `node --test dist/test/mapping.test.js` 单独验证映射。覆盖路由与静态文件、上传校验、限流、临时文件清理、软链启动、真实 JPEG 解析、厂商标签优先级与计数合理范围。诊断回归测试覆盖请求 ID 关联、安全的失败分类，以及诊断输出不包含照片内容和私密元数据。

浏览器测试使用本机已安装的 Chrome（可设置 `CHROME_PATH`），会新建隔离会话，覆盖真实上传、取消、重试、诊断、键盘操作和移动端布局。测试期间拦截所有外部请求，包括百度统计。无须下载浏览器。

CI 在构建前记录 `REVISION`，并执行 `npm run test:production`。该检查在临时目录只安装生产依赖，核验复制的版本号、稳定引导入口、静态资源、有效上传配置、Nikon 计数 526 和正常关闭。本地运行方式：

```bash
git rev-parse HEAD > REVISION
npm run build
npm run test:production
```

### 冒烟测试运行中的实例

先单独启动服务，再运行：

```bash
npm run smoke -- [baseUrl] file1.jpg [file2.jpg ...]
# 使用仓库样本与默认本地地址的示例：
npm run smoke -- test/fixtures/NikonD70.jpg
```

- `baseUrl` 可省略，默认为 `http://127.0.0.1:3020/shutter`。
- 检查首页返回 HTTP 200 HTML、健康检查返回 HTTP 200，然后逐个上传 JPEG，打印 `status / model / shutterCount / capturedAt`。
- 页面或健康检查失败、文件/网络错误、或解析请求返回 HTTP 5xx 时，退出码非零。解析请求的 4xx 会打印，但本身不会让该脚本失败；错误处理的断言应使用 `npm test`。
- 冒烟脚本会在自身控制台打印文件名和解析出的元数据。它与服务端限制隐私信息的诊断日志不同，请勿将涉及私密照片的脚本输出公开。

## API

所有接口位于 `BASE_PATH` 下，默认是 `/shutter`。

应用产生的每个 API 响应（包括错误与健康检查）都带有 `X-Request-ID` 响应头。ID 由服务端生成，为 UUID；客户端传入的 `X-Request-ID` 不能指定或替换它。解析与健康检查接口的 JSON 响应还包含同值的 `requestId` 字段。

### `GET /shutter/api/health`

正常返回 HTTP 200 和 `{ "status": "ok", "exiftool": "<version>", "revision": "<commit-sha-or-null>", "requestId": "<uuid>" }`。发布目录有有效 `REVISION` 文件时，`revision` 为 commit SHA 字符串；普通本地 checkout 中为 JSON `null`。该值在进程启动时读取，避免切换软链后旧进程冒认新版本。ExifTool 不可用时返回 HTTP 500 和 `{ "status": "error", "requestId": "<uuid>" }`。其中 `<version>` 为版本号，`<uuid>` 为请求 ID，同一 ID 也出现在响应头中。

```bash
curl -i http://127.0.0.1:3020/shutter/api/health
```

### `POST /shutter/api/parse`

- 请求：`multipart/form-data`，使用名为 **`file`** 的字段上传一个文件。
- 仅接受 JPG/JPEG：服务端检查扩展名与 `FF D8 FF` 魔术字节，再由 ExifTool 校验文件。
- 默认限流：每 IP 每分钟 30 次，只作用于解析接口。

```bash
curl -i \
  -F 'file=@test/fixtures/NikonD70.jpg' \
  http://127.0.0.1:3020/shutter/api/parse
```

| `status` | HTTP | 含义 |
| --- | --- | --- |
| `ok` | 200 | 找到可用的快门次数 |
| `no_shutter_field` | 200 | JPEG 有效，但没有可用且受支持的快门字段 |
| `unsupported_or_corrupt` | 422 | 非 JPEG，或 ExifTool 明确报告图片损坏/无效；`reason` 为 `not_jpeg` 或 `corrupt` |
| `file_too_large` | 413 | 超过上传上限；包含 `maxMb` |
| `bad_request` | 400 | 缺少文件、文件字段名错误或上传格式不正确 |
| `rate_limited` | 429 | 解析请求过于频繁，请稍后重试 |
| `error` | 500 | 未预期的服务端错误 |
| `error` | 503 | ExifTool 超时或未能完成读取；`reason` 为 `timeout` 或 `parser_unavailable` |

成功示例（ID 与照片数据仅作演示）：

```json
{
  "status": "ok",
  "requestId": "eb4d7287-0bd3-461e-8a8e-d978d46c8407",
  "fileName": "photo.jpg",
  "make": "NIKON CORPORATION",
  "model": "Nikon D750",
  "shutterCount": 12345,
  "shutterSource": "Nikon:ShutterCount",
  "approximate": false,
  "note": null,
  "capturedAt": "2024-05-01 12:34:56"
}
```

`fileName` 是清理后的展示名称，不是存储路径。`approximate` 和 `note` 说明可能与机械快门动作次数不同的计数。缺失元数据为 `null`；`no_shutter_field` 会保留可读到的品牌、型号与拍摄时间，快门次数为 null。

失败示例，响应头 `X-Request-ID` 与 JSON 中的 ID 相同：

```json
{
  "status": "unsupported_or_corrupt",
  "requestId": "edaa18de-1f94-4b81-9b95-e6c721aa04be",
  "reason": "corrupt",
  "fileName": "photo.jpg",
  "message": "无法解析该文件，图片可能已损坏。"
}
```

`requestId` 仅用于关联诊断，不能据此取回上传的照片。`stage` 和 `diagnosticCode` 是服务端日志字段，不是公开 API 字段。ExifTool 超时或读取异常返回 HTTP 503，`status: "error"`，`reason: "timeout"` 或 `"parser_unavailable"`。它们表示工具/服务故障，不能据此判断照片损坏。ExifTool 明确报告图片错误或 JPEG 格式警告时，仍返回 HTTP 422 和 `unsupported_or_corrupt` / `corrupt`。

## 支持的品牌与标签优先级

对于已识别品牌，只从该厂商自身的 MakerNotes 组按下列顺序读取。候选值必须是 `0 < n ≤ 5,000,000` 的整数；无效值会跳过，继续尝试下一候选。

| 品牌 | 标签优先级 | 备注 |
| --- | --- | --- |
| Nikon | `ShutterCount` → `MechanicalShutterCount` | |
| Canon | `ShutterCount` → `ImageCount` | `ImageCount` 为近似值，格式化存储卡后可能归零 |
| Sony | `ShutterCount` → `ShutterCount2` → `ShutterCount3` | |
| FUJIFILM | `ImageCount` | 近似拍摄计数，含电子快门；固件升级后可能归零 |
| PENTAX | `ShutterCount` | 包含 Ricoh Imaging / Asahi 品牌标识 |
| OLYMPUS | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | 包含 OM Digital / OM System 标识；有可用字段则读取 |
| Panasonic | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | 有可用字段则读取 |

未识别品牌会兜底读取带组名的 `ShutterCount` 标签。识别品牌不代表所有机型或 JPEG 都包含计数。编辑、导出或聊天软件转存后的图片可能已丢失 MakerNotes，建议使用相机直出原图。

## 诊断与排障

### 复制失败报告

读不到快门或出现错误时，可在结果页点击 **复制诊断信息**。复制内容包含可用的请求 ID、状态、原因与浏览器的 UTC 时间，不包含照片、文件名、机身型号/序列号、GPS 或 EXIF 值。自动复制不可用时，可选中只读报告手动复制。

浏览器本地校验未通过时不会上传，因此没有服务端请求 ID。网络失败或浏览器超时也可能导致浏览器拿不到 ID；诊断信息会明确标记不可用，不会编造 ID。网络失败后没有 ID，不代表服务端一定没有收到上传。

### 查找对应的服务端事件

启用日志后，每个完成响应的解析请求都会产生一条结构化 `parse_result` 事件，覆盖成功、失败、上传被拒绝以及限流：

| 字段 | 含义 |
| --- | --- |
| `requestId` | 与响应相同的服务端 UUID |
| `status` | 公开的结果状态 |
| `httpCode` | HTTP 响应码 |
| `durationMs` | 请求处理耗时，单位毫秒 |
| `stage` | `upload`、`validation`、`exiftool`、`mapping` 或 `complete` |
| `diagnosticCode` | 稳定且更具体的成功或失败分类 |

事件载荷示例（日志框架还会添加自身的标准字段）：

```json
{
  "event": "parse_result",
  "requestId": "65d39e92-207c-46aa-9051-c86e6a0b5b7e",
  "status": "error",
  "httpCode": 503,
  "durationMs": 15102,
  "stage": "exiftool",
  "diagnosticCode": "exiftool_timeout"
}
```

| `diagnosticCode` | 排查方向 |
| --- | --- |
| `upload_missing_file` | 使用 `file` 字段提交一个文件 |
| `upload_invalid_field` | 将 multipart 文件字段名改为 `file` |
| `upload_invalid_extension` | 使用 `.jpg` 或 `.jpeg` 原图 |
| `upload_invalid_magic` | 文件签名或解析出的文件类型不是 JPEG；改扩展名不能转换格式 |
| `upload_too_large` | 检查服务端、浏览器与反向代理的大小限制 |
| `upload_invalid_multipart` | 检查 multipart 边界与请求体；让浏览器或 `curl -F` 自动设置内容类型 |
| `exiftool_timeout` | HTTP 503 工具超时，不代表图片损坏；检查负载与 ExifTool 健康状态，再用正常样本重试 |
| `exiftool_read_failed` | HTTP 503 工具/读取故障，也包括无效的解析器返回；先检查健康状态和正常样本，不能直接归因于图片 |
| `exiftool_reported_error` | ExifTool 报告了图片错误 |
| `jpeg_format_error` | JPEG 结构无效或不一致 |
| `no_shutter_field` | 尝试相机原图；该型号可能没有受支持的可用计数 |
| `parse_ok` | 成功映射快门次数 |
| `internal_error` | 检查服务健康和运行条件，例如临时目录访问权限 |
| `rate_limited` | 等待限流窗口结束；若无关用户共用限额，检查代理信任配置 |

执行标签映射后，可选的 `mapping` 摘要包含 `brand`（规范化的已知品牌标识或 `unknown`）、`hasExif`、`candidateCount`、`presentCandidateCount` 与 `invalidCandidateCount`。它们是安全的分类、布尔值和数量，不会暴露标签值；其他附加诊断也只使用预定义字段状态。这些事件不写入原始错误、任意 EXIF 值、文件名、机身型号、序列号或 GPS。排障时不要打开原始请求体或完整 EXIF 日志。

未预期的内部故障还会包含白名单内的 `errorCode`（例如 `ENOENT`、`EACCES`、`ENOSPC` 或 `UNKNOWN`），便于区分存储/系统故障，同时避免暴露错误原文或路径。

健康检查会单独产生 `health_result` 事件，代码为 `health_ok` 或 `exiftool_unavailable`。临时目录清理失败会记录 `temp_cleanup_failed`；运维应检查临时存储，不能假定文件已经删除。

### 日志位置、重启与保留

`npm start` 和 PM2 入口会启用结构化日志，写入进程输出。`buildApp()` 为测试/嵌入使用默认关闭日志，除非显式传入 logger。应用没有新增数据库或独立日志存储服务。

使用仓库中的 PM2 配置时：

```bash
pm2 logs shutter-count --lines 100
pm2 describe shutter-count   # 查看实际的标准输出/错误日志路径

# 将界面或 API 返回的请求 ID 填入，查询两个默认日志文件：
REQUEST_ID='65d39e92-207c-46aa-9051-c86e6a0b5b7e'
grep -F -- "$REQUEST_ID" \
  "${PM2_HOME:-$HOME/.pm2}/logs/shutter-count-out.log" \
  "${PM2_HOME:-$HOME/.pm2}/logs/shutter-count-error.log"
```

PM2 默认写到 `~/.pm2/logs/`（或 `$PM2_HOME/logs/`）。本配置启用了时间戳前缀，因此 PM2 文件中的每行 JSON 前可能还有文本；使用 `grep` 无需先剥离前缀。实际部署不同的话，以 `pm2 describe` 显示的路径为准。

PM2 日志文件通常会跨应用重启保留，但这不是备份或保留时长保证。轮转、磁盘限额、访问控制和备份由运维配置。单纯的 stdout，尤其是容器内 stdout，在重启或替换后未必可持久保留；应配置进程管理器/平台的采集与保留策略。当前文件找不到旧请求时，也要检查已轮转或归档的日志。

若找不到对应事件，请核对实例与日志位置、当时是否启用了日志，以及请求是否在到达 Fastify 前就被代理拒绝。浏览器本地校验不会生成服务端事件。按时间排查时，还需注意浏览器与服务端的时钟、时区可能不同。

## 部署约定

经过测试的版本发布与 GitHub Actions 配置见[自动部署说明](docs/DEPLOYMENT.zh-CN.md)（[English](docs/DEPLOYMENT.md)）。默认关闭自动部署，须核实主机并明确启用；仅添加工作流不会部署或授予访问权限。

仓库记录了面向 `rende.fun` 的以下部署布局；这些配置并不证明线上当前状态或已部署版本。

- 运行环境：Node.js ≥ 22，这是锁定的 `exiftool-vendored` 39 依赖的要求。修正运行环境声明不涉及依赖升级。
- 版本目录：`/opt/shutter-count/releases/<id>/`，`/opt/shutter-count/current` 软链指向当前版本。启动入口兼容软链路径。
- 进程管理：PM2，应用名 **`shutter-count`**，配置见 `ecosystem.config.cjs`。可用 `SHUTTER_APP_DIR` 指定发布目录。
- 监听地址：默认 `127.0.0.1:3020`。
- 反向代理：可将主机上的 `snippets/shutter-locations.conf` 包含到 nginx 站点配置，把 `/shutter` 反代到本机 3020。此主机侧 snippet 不在仓库内。保留无关的 `easypic` 既有配置。

```bash
pm2 start ecosystem.config.cjs   # 首次启动
pm2 reload shutter-count        # 切换发布软链后重载
pm2 logs shutter-count
```

## 隐私与数据处理

- 上传文件暂时写入系统临时目录下独立的 `shuttercount-*` 子目录。客户端文件名不用于磁盘存储路径。
- 解析响应发送前会尝试清理，并等待清理操作结束。清理是尽力而为的：文件系统错误或进程崩溃可能留下临时文件。
- 服务启动时会尝试清理超过 10 分钟的 `shuttercount-*` 目录。这不是持续清理服务，也不能保证崩溃后的删除；运维仍需考虑临时存储与文件系统备份。
- 不设图片数据库，不主动长期归档图片。返回给上传者的解析结果可能包含清理后的文件名和选定的相机元数据；服务端诊断事件与界面复制的诊断报告不会包含这些值。
- 诊断使用允许的分类与摘要，不记录照片字节、完整 EXIF、原始异常信息或堆栈。请求 ID 仅用于关联事件，没有新增照片下载/历史记录 API。
- 反向代理、进程管理器、托管平台与备份的日志/存储有各自的策略，部署时需单独检查。

容量达到上限或等待超时时，解析接口返回 HTTP 503 / `error` / `busy`，日志使用 `parser_queue_full`、`parser_queue_timeout` 或 `parser_closed`。应用按实例关闭 ExifTool；SIGINT/SIGTERM 触发最多 20 秒的清理，PM2 `kill_timeout` 必须为 25000 ms，见部署指南。
