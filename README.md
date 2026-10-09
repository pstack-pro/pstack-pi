# pi-pstack

把 [pstack](https://github.com/cursor/plugins/tree/main/pstack)（poteto 的严谨 agent 工作流）适配到 [pi](https://pi.dev) coding agent 的 pi package。

pstack 的 skill 是照着 Cursor 的工具写的。这个 package 没有逐个改写 skill，而是在 pi 里提供**同名、同参数**的工具，让 skill 正文基本保持原样：

| 工具 | 作用 |
|---|---|
| `Task` | 起一个独立的 `pi` 子进程做 subagent。支持 `subagent_type`、`model`、`readonly`、`run_in_background`、`resume`、`cwd`。同一条消息里的多个 `Task` 会并行执行 |
| `Await` | 等待后台 `Task` 的结果 |
| `AskQuestion` | 结构化的多选提问。没有 UI 时（`-p` 模式）会让模型按 Autonomy 规则自己决定 |
| `PstackModels` | 列出 pi 当前能用的模型，以及它们的单价和支持的 thinking 档位，供 `setup-pstack` 使用 |

扩展还会在每次提问前把项目里的 `.pi/pstack-models.md`（按角色配置模型）和一段 pi 适配说明注入 system prompt，作用相当于 Cursor 里那条 always-applied rule。

## 前置条件

- [pi](https://pi.dev) 1.0 或更高版本（在 1.0.2 上测试过）
- 至少一个 pi 能用的模型 provider，用 `pi --list-models` 确认
- 安装方式选 `git:` 时，本机需要有 `git`

## 安装 / 试用 / 卸载

在要启用 pstack 的项目根目录执行：

```bash
# 只在当前项目启用（写入 .pi/settings.json；首次运行 pi 时需要信任该项目）
pi install -l git:github.com/taokeqin/pi-pstack

# 只试一次，不写任何配置
pi -e git:github.com/taokeqin/pi-pstack

# 从当前项目卸载
pi remove -l --approve git:github.com/taokeqin/pi-pstack
```

想改代码或固定在本地某个版本时，可以 clone 到任意目录，然后用本地路径安装：

```bash
git clone https://github.com/taokeqin/pi-pstack.git <任意目录>
pi install -l <任意目录>
```

注意：pi 在 `.pi/settings.json` 里保存的是**相对于该文件的路径**。如果之后移动了项目目录或 clone 的目录，需要重新安装一次。

这个 package 不会往 `~/.pi/agent/` 写任何东西：agent 定义从 package 自己的 `agents/` 目录读取，模型配置写在项目的 `.pi/pstack-models.md`，subagent 的 session 存放在系统临时目录的 `pi-pstack-sessions/` 下。

## 开始用

1. `/skill:setup-pstack`：用 `PstackModels` 检测可用模型和价格，先并行 ping 一遍确认能用，再按角色写入 `.pi/pstack-models.md`。
2. `/skill:poteto-mode <任务>`：主入口，会自动选择 playbook。

`setup-pstack` 的分配规则：

- **推荐方案**：内置一个 `mimo-deepseek` 方案，**只有**同时检测到 `xiaomi/mimo-v2.6-*` 和 `deepseek/deepseek-*` 时才会推荐。判断类角色用 `mimo-v2.6-pro`，写代码用 `deepseek-flash`，`deepseek-v4-pro` 只给 hardest tasks。
- **其他情况**：按成本规则自动分配。同等能力选更便宜的；不用 ultraspeed 这类加价的高速版本；最贵的模型只给 hardest tasks。
- 两种情况下，你都可以在确认那一步修改任何角色。想加自己的推荐方案，在 `overrides/skills/setup-pstack/SKILL.md` 里照着 `mimo-deepseek` 的写法添加。

不跑 setup 也能用：skill 里写的默认模型（如 `grok-4.7-xhigh-fast`）如果 pi 跑不了，`Task` 会退回父会话的模型，并在结果的 `note` 里说明。

模型可以写成 pi 格式（`provider/id:thinking`），也可以写成 Cursor 风格的 slug（`claude-opus-5-5-max`），后者会自动拆出 thinking 档位。

## 跟进上游

```bash
node scripts/sync.mjs                        # 自动浅克隆 github.com/cursor/plugins 到系统临时目录
node scripts/sync.mjs <plugins 仓库>/pstack   # 或者指定本地已有的 checkout
PSTACK_SRC=<plugins 仓库>/pstack node scripts/sync.mjs

test/run.sh                                  # 用 mock 模型做端到端测试：不调用真实模型，不碰 ~/.pi/agent
```

`sync.mjs` 会重新生成 `skills/` 和 `agents/`：替换 Cursor 路径，把 skill 的 `name` 统一成目录名（pi 用它作为 `/skill:` 命令名），再叠加 `overrides/` 里手写的文件（目前只有 `setup-pstack`）。上游版本记录在 `UPSTREAM.json`。

## 已知差异

- `environment: "cloud"` 不支持，一律在本地运行。多个 subagent 并行写代码时，要通过 `cwd` 给它们各自分配 git worktree。
- Cursor 内置的功能（`create-skill`、`/loop`、Plan Mode、automations、云端 dashboard）在 pi 里都没有。注入的说明会告诉模型直接按 pstack 的 playbook 走。
- 没有移植 `automations/benny`。`poteto-mode/scripts/worktree-audit.sh` 仍然读取 `~/.cursor/projects`。
- subagent 最多嵌套 3 层，最多同时运行 6 个。
- 交互模式（TUI）下，后台任务完成后会通过 follow-up 消息通知主会话，这条路径没有自动化测试；`-p` 模式下等待后台任务的路径有测试覆盖。

## 许可

pstack 原作者 Lauren Tan，MIT 许可，见 `LICENSE-pstack`。
