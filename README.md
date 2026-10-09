# pi-pstack

把 [pstack](https://github.com/cursor/plugins/tree/main/pstack)（poteto 的严谨 agent 工作流）适配到 [pi](https://pi.dev) coding agent 的 pi package。

pstack 的 skill 是照着 Cursor 的工具写的。这个 package 没有逐个改写 skill，而是在 pi 里提供**同名、同参数**的工具，让 skill 正文基本保持原样：

| 工具 | 作用 |
|---|---|
| `Task` | 起一个独立的 `pi` 子进程做 subagent。支持 `subagent_type`、`model`、`readonly`、`run_in_background`、`resume`、`cwd`。同一条消息里的多个 `Task` 会并行执行 |
| `Await` | 等待后台 `Task` 的结果 |
| `AskQuestion` | 结构化的多选提问。没有 UI 时（`-p` 模式）会让模型按 Autonomy 规则自己决定 |

扩展还会在每次提问前把项目里的 `.pi/pstack-models.md`（按角色配置模型）和一段 pi 适配说明注入 system prompt，作用相当于 Cursor 里那条 always-applied rule。

## 安装 / 试用 / 卸载

```bash
# 只试一次，不写任何配置
pi -e ~/Code/pi-pstack

# 只在当前项目启用（写入 .pi/settings.json，需要信任该项目）
pi install -l ~/Code/pi-pstack

# 从当前项目卸载
pi remove -l --approve ~/Code/pi-pstack
```

不会往 `~/.pi/agent/` 写任何东西。agent 定义从 package 自己的 `agents/` 目录读取，模型配置写在项目的 `.pi/pstack-models.md`。subagent 的 session 存放在系统临时目录的 `pi-pstack-sessions/` 下。

## 开始用

1. `/skill:setup-pstack`：从 `pi --list-models` 检测可用模型，按角色写好 `.pi/pstack-models.md`。
2. `/skill:poteto-mode <任务>`：主入口，会自动选择 playbook。

不跑 setup 也能用：skill 里写的默认模型（如 `grok-4.7-xhigh-fast`）如果 pi 跑不了，`Task` 会退回父会话的模型，并在结果的 `note` 里说明。

模型可以写成 pi 格式（`provider/id:thinking`），也可以写成 Cursor 风格的 slug（`claude-opus-5-5-max`），后者会自动拆出 thinking 档位。

## 跟进上游

```bash
node scripts/sync.mjs [path/to/plugins/pstack]   # 默认 ~/Code/opensource/plugins/pstack
test/run.sh                                     # 用 mock 模型做端到端测试，不花钱、不碰 ~/.pi/agent
```

`sync.mjs` 会重新生成 `skills/` 和 `agents/`：替换 Cursor 路径，把 skill 的 `name` 统一成目录名（pi 用它作为 `/skill:` 命令名），再叠加 `overrides/` 里手写的文件（目前只有 `setup-pstack`）。上游版本记录在 `UPSTREAM.json`。

## 已知差异

- `environment: "cloud"` 不支持，一律在本地运行。多个 subagent 并行写代码时，要通过 `cwd` 给它们各自分配 git worktree。
- Cursor 内置的功能（`create-skill`、`/loop`、Plan Mode、automations、云端 dashboard）在 pi 里都没有。注入的说明会告诉模型直接按 pstack 的 playbook 走。
- 没有移植 `automations/benny`。`poteto-mode/scripts/worktree-audit.sh` 仍然读取 `~/.cursor/projects`。
- subagent 最多嵌套 3 层，最多同时运行 6 个。
- 交互模式（TUI）下，后台任务完成后会通过 follow-up 消息通知主会话，这条路径没有自动化测试；`-p` 模式下等待后台任务的路径有测试覆盖。
