# 受限 SSH 自动发布

[English](DEPLOYMENT.md) | [简体中文](DEPLOYMENT.zh-CN.md)

## 发布流程

`Test and deploy` 工作流使用 Node 22 测试 PR 和每次 `main` 更新。`test` 成功后，已启用的 main 发布进入 `production` 环境，只通过 SSH 发送：

```text
deploy <完整 40 位 commit SHA> <GitHub run ID> <run attempt>
```

SSH 用户固定为 `shutter-deploy`，客户端不能指定仓库、服务器路径、执行程序、环境或上传脚本。管理员安装的固定接收器独立核验公开仓库的当前 main、指定 run/attempt 及其 `test` job 成功结果。GitHub API 出错或限流时停止，不冒险发布；服务器不保存 GitHub token。

接收器拉取精确提交、校验对象并解出干净源码。服务器按锁文件安装依赖并重跑测试。root 管理的发布脚本在切换前再次检查 main，然后原子切换 current，仅重启已核验的 Shutter PM2 ID，检查内网/公网页面、ExifTool 健康及运行中的精确 revision。激活后失败会恢复旧版本并核验其内网健康，旧目录保留。

GitHub 部署并发组不会取消正在进行的发布，服务器另有 flock 锁。main 前进后，旧排队/准备中的版本不会覆盖新版。GitHub 可能替换待执行任务，因此保证趋向最新通过测试的版本，不承诺上线每个中间提交。PM2 单进程重启可能短暂中断，不是零停机发布。

## 服务器前置条件及管理员设置

这是已有服务的更新工具，不会自动初始化服务器。[deploy/deploy.example.json](../deploy/deploy.example.json) 绑定本项目；配置值是待核验条件，不代表设置已经完成。

- 独立 shutter-deploy 账号、锁密码、无 sudo/特权组，只能写自身应用和状态目录。
- Node 22 位于 /opt/node-v22.23.2-linux-x64/bin；具备 npm、PM2、Git、Bash、GNU coreutils/tar 和 flock。
- /opt/shutter-count/current 指向真实 releases/ 中的版本。唯一在线 Shutter PM2 进程使用稳定的 current 工作目录及 current/bin/start.mjs，环境与仓库配置一致，Node 22+。
- root 管理的 pm2-shutter-deploy.service 仅用 /etc/shutter-count/ecosystem.config.cjs 启动该账号的 PM2。所有权迁移后，root PM2 启动项、主 dump 和备份 dump 不得继续引用 Shutter。发布不运行 pm2 save/restart all，也不以 root 部署。
- 已有 http://127.0.0.1:3020/shutter 和 https://rende.fun/shutter 路由。日常发布不改 nginx 或防火墙。

获得明确授权后，管理员把审阅通过的 scripts/receive-deploy.mjs、scripts/deploy-release.sh 和 scripts/check-deploy.mjs 安装到 /usr/local/libexec/shutter-count/，把示例 JSON 安装为 /etc/shutter-count/deploy.json。这些文件及上级目录均由 root 拥有，应用账号不可写。发布脚本使用安装目录内可信的健康检查器，而非候选版本提供的脚本。今后更新这些控制脚本需要明确的管理员操作，合并仓库不会悄悄替换它们。

公钥保存在可写应用 HOME 之外、由 root 管理的 /etc/ssh/authorized_keys/shutter-deploy，仅一把部署公钥，带 restrict,command="<固定启动器>"。Match User shutter-deploy 专属配置只读这个公钥文件，设置 AuthorizedKeysCommand none 禁用继承的云登录 helper，并 ForceCommand 同一启动器；禁用转发、TTY、user rc、密码/键盘交互认证，仅允许 publickey。先用 sshd -t 及 sshd -T -C 检查当前 OpenSSH 的实际配置和版本支持，再重新加载，并保留其他用户设置。

将已校验的同版 Node 22 二进制安装为 /usr/local/libexec/shutter-count/receive-node，由 root 拥有且应用不可写。接收器只接受这个专用解释器，验证阶段 Git/tar 仅使用系统 PATH；既有应用/npm/PM2 运行时分开保留，但部署账号必须不可写，发布不改变已核验的应用解释器。

固定启动器使用 receive-node 和清理过的环境启动 receiver；SSH_ORIGINAL_COMMAND 仅作为不可信文本交给严格解析器，不 eval、不拼成 shell。还需检查 AcceptEnv、PermitUserEnvironment、账号 shell 和启动文件，防止可写 .bashrc、BASH_ENV 等在入口前执行。restrict 不能代替 shell 启动安全。账号不得自行添加其他授权公钥或修改入口/配置。

启用前验证拒绝场景：交互 shell、SFTP/SCP、转发/TTY、非法输入、非 main SHA、其他仓库/run、失败测试、旧 attempt。确认有效发布在专用 UID 下执行且不能 sudo，并用该账号/PM2 完成真实发布及健康失败回滚。mock 单元测试不代表服务器权限已验收。

## GitHub 设置与私钥安全输入

持续访问需单独明确授权。用户在可信环境生成 Shutter 专用部署密钥，并亲自在 GitHub 的 production 环境 Secret 安全界面填入私钥，名称为 SHUTTER_DEPLOY_SSH_KEY。私钥不得进入聊天、仓库、issue、日志或构件；助手可经授权配置公钥，但不能读取或转传私钥。轮换/撤销时删除服务器旧公钥，并通过同样安全流程更换环境 Secret。

production 的 selected branch 规则只允许 main，不配置 tag 规则。main 和 workflow 修改应有适当审查和必需 CI；YAML 不会自动设置分支保护。若希望每次发布人工审批，可以添加环境 reviewer；无人值守发布需明确授权。

仓库变量：

| 名称 | 值 |
| --- | --- |
| SHUTTER_DEPLOY_ENABLED | 验收前留空，最后设 true |

production 环境变量：

| 名称 | 值 |
| --- | --- |
| SHUTTER_DEPLOY_HOST | 已核验 SSH 域名或 IPv4 |
| SHUTTER_DEPLOY_PORT | 已核验端口，留空为 22 |
| SHUTTER_DEPLOY_KNOWN_HOSTS | 可信主机公钥条目，非默认端口使用 [host]:port |
| SHUTTER_DEPLOY_PUBLIC_URL | https://rende.fun/shutter |

唯一环境 Secret 为 SHUTTER_DEPLOY_SSH_KEY。通过已信任的 Workbench 等控制台读取主机公钥/指纹，再固定 known_hosts；首次 ssh-keyscan 输出本身不能证明主机真实身份。客户端强制校验主机密钥，使用临时 0600 私钥文件，从 SSH 子进程环境移除私钥并清理临时文件；不使用第三方 SSH Action 或 SSH agent。

工作流只有 contents:read，官方 checkout/setup action 固定完整提交，不持久化 checkout 凭据、没有 OIDC 权限。PR 不接触生产 Secret；部署 needs:test，并只允许 main 的 push/手动触发。服务器校验是额外防线，不替代 main/workflow 审查。

## 验证与恢复

1. 完成 PR 审查和测试，由管理员安装已审阅的入口/启动器。
2. 核验身份限制、PM2 开机路径和可信主机公钥，让用户安全填写私钥 Secret。
3. 启用 SHUTTER_DEPLOY_ENABLED=true，在 main 运行工作流，核对精确 SHA 的 test/deploy 结果及两侧健康接口。跳过的部署不算上线。
4. 再验证一次后续合并能自动发布，之后才依赖无人值守流程。

服务器发布成功后，runner 的最终公网检查仍可能因网络失败。此时工作流失败，但不会启动第二次并发回滚。重试前先查实际 revision、路由、TLS 和 runner 网络，不能把失败自动理解为已经回退。

服务器发布输出保存在 /opt/shutter-count/deploy-<release-id>.log，不直接转发到 runner。重试 CI 时重跑完整工作流，让同一 attempt 包含成功的 test job。激活失败的恢复日志保存在 /opt/shutter-count/rollback-<release-id>.log。出现 CRITICAL 时，先检查 current、PM2 和健康再发布。断线/HUP/TERM 有恢复测试，但 SIGKILL、断电或磁盘故障仍可能阻止回滚。旧版本保留，不自动清理。设 SHUTTER_DEPLOY_ENABLED=false 只停后续发布，不取消服务器上已进行的操作。

## 安全边界

固定命令限制的是 SSH 入口，不是可信 main 代码的沙箱。依赖安装脚本、测试和应用都拥有 shutter-deploy 的完整账号权限，因此 main 修改仍需审查。部署私钥泄漏可能触发允许的发布和应用级破坏；这套设计不会刻意授予 root/sudo。同一 ECS 的账号共享内核和资源，不是绝对隔离；若以后附加实例 RAM 角色，还需单独审查元数据访问。本方案不创建整机云角色。

官方参考：[OpenSSH 公钥限制](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)、[sshd 配置](https://man.openbsd.org/sshd_config.5)、[主机公钥校验](https://man.openbsd.org/ssh-keyscan.1)、[GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)、[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。
