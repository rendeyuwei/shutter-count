# 部署

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

自动部署使用 [rendeyuwei/rende-deploy](https://github.com/rendeyuwei/rende-deploy) 的共享工作流。修改调用方或主机前，先阅读该仓库 `main` 上的 README 和 `.github/workflows/deploy-project.yml`。

## GitHub Actions

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 在推送到 `main` 时运行，也可手动触发。它调用：

```yaml
uses: rendeyuwei/rende-deploy/.github/workflows/deploy-project.yml@main
```

并传入 `project: shutter`。共享工作流安装依赖、执行本仓库的测试命令，然后通过 SSH 只发送：

```text
deploy shutter <40 位十六进制 SHA>
```

部署任务等待该测试任务完成。`main` 上测试成功后总会部署。并发设置为 `cancel-in-progress: false`，新的推送会等待已经开始的部署。

ECS 按 `/etc/rende-deploy/projects/shutter.conf` 里的 `build` 行编译。修改 runner 的 `test_command` 不会改变这条服务器命令。

拉取请求运行 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)。该工作流重复同样的检查，并且不会收到部署密钥。

仓库密钥与其他 rende.fun 调用方相同，共四项：

| 密钥 | 值 |
| --- | --- |
| `ECS_HOST` | ECS 主机名或 IP，与控制台核对 |
| `ECS_USER` | `rende-deploy` |
| `ECS_SSH_KEY` | 该用户的私钥，与 rende-site 使用同一把 |
| `ECS_KNOWN_HOSTS` | 与控制台比对过的主机公钥行，不要直接采信 `ssh-keyscan` |

合并此工作流前，`ECS_USER` 必须是 `rende-deploy`。私钥只放在 GitHub 的 Secret 界面中。

## 主机

项目 id `shutter` 对应 ECS 上的 `/etc/rende-deploy/projects/shutter.conf`。目录是 `/opt/shutter-count`，PM2 应用名是 `shutter-count`，接收器的健康检查是 `http://127.0.0.1:3020/shutter`。SSH 成功后，runner 还会请求 `https://rende.fun/shutter/`。不带结尾斜线的路径返回 308，runner 不会跟随重定向。接收器、强制命令和项目配置的安装方式见 rende-deploy。合并本仓库不会更新 `/usr/local/libexec/`。

`/opt/shutter-count` 必须可由 `rende-deploy` 写入。第一次通过共享流程部署前，所有权可能需要从 `shutter-deploy` 改为 `rende-deploy`。PM2 进程必须使用 `/opt/shutter-count/current`，这样重启才会跟随软链。PM2 `kill_timeout` 保持 `25000`，以便应用完成最多 20 秒的关闭清理。

## 布局

以下是面向 `rende.fun` 的预期布局，并不证明线上正在运行的版本。

- 运行环境：Node.js 22，位于 rende-deploy 为 `shutter` 配置的 `PATH`（本机为 `/opt/node-v22.23.2-linux-x64/bin`）。
- 版本目录：`/opt/shutter-count/releases/<id>/`，`/opt/shutter-count/current` 指向当前版本。
- 进程管理：PM2 应用 `shutter-count`。
- 监听地址：`127.0.0.1:3020`。
- 公网地址：`https://rende.fun/shutter`。
- 反向代理：`/shutter` 的 nginx 片段留在主机上，不在本仓库内。日常发布不修改 nginx。
