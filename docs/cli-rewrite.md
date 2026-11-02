docs/cli-rewrite.md# git-cl 命令行 TS 重写

本文档是一个独立项目的说明：用 TypeScript 重写 `git cl` 命令行，放进本仓库，与 VS Code 插件共用同一份核心代码；并加上"隐藏的 list 不许再改"的保护。

按 AGENTS.md 的规矩执行：先向用户确认计划，每轮只交付一步，每步结束时插件和命令行都能正常使用。

## 背景

### 为什么要重写
- 现在的 `git cl` 是第三方 Python 工具 `git-changelists` 1.1.12（作者 Bjoern Hendrik Fock，仓库 https://github.com/BHFock/git-cl，BSD-3 许可）。它只有一个文件，约 3500 行，其中大半是文档注释。
- 安装位置：`~/.local/share/git-changelists/venv`，`/opt/homebrew/bin/git-cl` 是指向 `venv/bin/git-cl` 的符号链接。行为对照时直接读 `~/.local/share/git-changelists/venv/bin/git-cl`。
- 插件（本仓库）已经用 TS 重新实现了其中大部分逻辑：`changelistStore.ts`、`stashStore.ts`、`gitUtils.ts`、`stashOperations.ts`。同一套规则在两种语言里各维护一份，已经出过问题：list 里有已暂存的删除或 `git add -N` 的文件时 stash 会失败，插件这边已经在 `prepareIndexForStash` 里修了，Python 版没修。
- 重写后只剩一份实现。命令行和插件在同一个仓库，规则改一处就两边生效。

### 要解决的具体问题
用户在插件里点小眼睛，就会把一个 list 隐藏起来（底层是 `git stash`，记录在 `.git/cl-stashes.json`）。如果这时 AI 还在改这个 list，会出三个问题：
1. `git cl status <list名> --all` 在指定 list 名时**不显示**已隐藏的 list。AI 用的就是这种写法，所以它看不出自己的 list 被隐藏了。
2. `git cl add <同名> <文件>` 会成功，悄悄新建一个同名的普通 list。
3. AI 会在已经恢复成原样的文件上继续改。用户之后恢复时，就会报冲突。

## 子命令范围

只做 AI 和用户实际用到的 8 个，名字、别名和参数都和 Python 版一致：

| 子命令 | 别名 | 参数 |
|---|---|---|
| `add` | `a` | `CHANGELIST FILE...` |
| `remove` | `r`, `rm` | `FILE...` |
| `delete` | `del` | `[--all] [CHANGELIST...]` |
| `status` | `s`, `st` | `[--include-no-cl] [--all] [--no-untracked] [--no-color] [CHANGELIST...]` |
| `diff` | | `[--staged] [--both] CHANGELIST...` |
| `commit` | `ci` | `(-m MESSAGE \| -F FILE) [--keep] CHANGELIST` |
| `stash` | `sh` | `(--all \| CHANGELIST)` |
| `unstash` | `us` | `[--force] (--all \| CHANGELIST)` |

不做 `checkout`、`stage`、`unstage`、`branch`，插件里已经有这些功能。将来真需要时再加。

开工前先和用户确认这个范围。

## 必须保持兼容的地方

### 数据文件
- `cl.json`：`{ "<list名>": ["<相对仓库根目录的 posix 路径>", ...] }`，缩进 2 个空格，保存时去掉空 list。写入方式是先写临时文件 `.cl.json.XXXX.tmp`，再 `rename` 覆盖。
- `cl-stashes.json`：格式见 `src/stashStore.ts` 里的 `StashMetadata`，与 Python 版兼容。
- **放在哪个目录**：Python 版用 `git rev-parse --git-dir`，在 worktree 里会落到各自的 gitdir；插件用的是 common dir（`getGitCommonDir`）。两边不一致，统一成一种之前先问用户。

### 输出格式
smartodo 的 `tools/scripts/git_cl_prune.dart` 按行解析 `git cl status --all --no-color` 的输出，AGENTS.md 里的工作流也依赖它。所以输出要和 Python 版逐字一致：
- 文件行：`  [XY] <相对当前目录的路径>`，两个空格开头，`XY` 是 porcelain 状态。不在 git 状态里的文件显示 `[  ]`；文件不存在时显示 `[XX]`，并打印一行提示。
- 分组标题：`<list名>:`，未分组的文件放在 `No Changelist:` 下；已隐藏的 list 放在 `Stashed Changelists:` 区域，每行格式是 `  <名字> (<n> file, <YYYY-MM-DD HH:MM>)`。
- 默认只显示常见状态码：`?? ' M' 'M ' MM 'A ' AM ' D' 'D ' 'R ' RM`，加上冲突码 `UU AA DD AU UA DU UD`。其他状态码会被跳过，并打印 `Note: N file(s) with uncommon Git status codes were not shown...`；加 `--all` 时全部显示。
- 颜色：`NO_COLOR` 环境变量、`--no-color` 或输出不是终端时都不上色。配色规则见 Python 版的 `clutil_format_file_status`。
- 路径参数：相对于当前目录解析，再转成相对仓库根目录的路径。仓库外的路径，以及含 `; | & \` $` 或换行的路径，一律拒绝（见 `clutil_sanitize_path`）。

做法：每实现一个子命令，就在临时仓库里把 TS 版和 Python 版各跑一遍，逐字比对 stdout 和退出码。

### 文件锁
- Python 版在 `cl.json` 旁边用 `cl.lock` 加 `flock` 锁，用完删掉锁文件。它在读和写时各加一次锁，读改写整体不是原子的。
- 插件现在完全不加锁。
- 新实现要让命令行和插件共用同一把锁，并且锁住整个读改写过程。

## 新增的保护规则

### 命令行报错
在核心层实现，命令行和插件都会经过这里：
- `add <名字> ...`：如果这个名字在 `cl-stashes.json` 里，就报错退出（退出码非 0），提示类似：`Changelist "<名字>" is hidden by the user (stashed). Do not edit its files; ask the user before continuing.`
- `status <名字>`：指定的名字中如果有已隐藏的，输出同样的提示，并以非 0 退出码结束。不能再默默显示一个空列表。
- `add` 的文件如果属于某个已隐藏的 list，也要报错。这条规则 `changelistStore.addFiles` 里已经有了，要保留。

### 改文件前拦截（Claude Code hook）
命令行报错只能事后发现：AI 是先改文件，再运行 `git cl add`。要在改之前拦住，需要一个 PreToolUse hook：
- 新增一个子命令，例如 `git cl guard-edit`。它从 stdin 读取 hook 传来的 JSON，取出 `tool_input.file_path`，换算成相对仓库根目录的路径。如果这个路径属于 `cl-stashes.json` 里某个 list 的 `files`，就往 stderr 写一条提示并以退出码 2 结束，Claude Code 会据此拒绝这次修改。其余情况一律退出码 0，包括不在 git 仓库里、没有 stash 文件等。
- 在 `~/.claude/settings.json` 的 `hooks.PreToolUse` 里配置，matcher 设为 `Edit|Write|MultiEdit|NotebookEdit`，命令是 `git cl guard-edit`。配置前先给用户看要改的内容。
- 局限：AI 通过 Bash 用 sed 或重定向改文件时拦不住。
- Codex 等其他 AI 读不到这个 hook，需要在 smartodo 的 AGENTS.md 的 Changelists 一节里补一句：改文件前若 `git cl add` 或 `git cl status` 报告 list 已隐藏，立即停止并询问用户。这个改动要先经用户同意。

## 架构

```
src/
  core/        不依赖 vscode：store、stash store、git 操作、stash 预处理/收起/恢复、锁、路径处理
  cli/         命令行：参数解析、各子命令、输出格式化；入口 cli/main.ts
  commands/    插件命令（已存在），改为调用 core
  extension.ts
```

- 现状：`changelistStore.ts`、`stashStore.ts`、`gitUtils.ts`、`fileTree.ts`、`reviewPrompt.ts` 已经不依赖 vscode。`stashOperations.ts` 不行，它里面直接调用了 `vscode.window` 的弹窗。
- 解耦方式：核心函数返回结果或抛出带类型的错误；需要用户确认的地方（比如分支不一致、有冲突）由调用方决定，插件弹窗询问，命令行按 `--force` 处理。核心层不能出现 `vscode` 的导入。
- 打包：用 esbuild 再打一个 `dist/cli.js`（`--platform=node`，带 shebang），`package.json` 增加 `bin`。安装脚本把 `/opt/homebrew/bin/git-cl` 改指向它；Python 的 venv 保留，方便回退。
- 测试：只测核心层里看代码看不出问题的部分，包括数据文件读写和兼容性、锁、路径处理、stash 预处理，以及 guard-edit 的判断。输出格式靠和 Python 版比对来验证，不写快照测试。

## 建议的步骤

每步都要保持插件可用，Python 版 `git cl` 在第 5 步之前继续工作。

0. **guard-edit hook**：先用一个独立的小脚本实现（读 `cl-stashes.json` 判断），这是真正防止冲突的一步，所以最先做。第 3 步之后再改成命令行子命令。
1. **核心层解耦**：建 `src/core/`，把不依赖 vscode 的模块移进去，`stashOperations.ts` 拆成核心部分和插件的弹窗部分。插件行为不变。
2. **命令行骨架和只读命令**：`status`、`diff`，先装成 `git-cl-ts`，和 Python 版逐字比对。
3. **写入命令和锁**：`add`、`remove`、`delete`、`commit`，插件和命令行共用同一把锁。加入"add 到已隐藏 list 报错"的规则，把 guard-edit 改成子命令。
4. **`stash` / `unstash`**：复用核心层的收起和恢复（包含 `prepareIndexForStash`）；加入"status 指定已隐藏 list 时报错"的规则。
5. **切换**：`/opt/homebrew/bin/git-cl` 改为指向 TS 版，在 smartodo 里按 AGENTS.md 的工作流完整走一遍；AGENTS.md 的补充那句话也在这一步提出。

## 待用户确认
- 子命令范围（上面的 8 个）。
- 数据文件放在 gitdir 还是 common dir。
- hook 配在全局（`~/.claude/settings.json`）还是只配在 smartodo 项目里。
