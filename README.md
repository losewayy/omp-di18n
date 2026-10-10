# omp-di18n

**简体中文 | [English](README.en.md)**

**[oh-my-pi](https://github.com/can1357/oh-my-pi)（omp）的简体中文界面扩展——无需 fork、无需重新编译，直接作用于官方二进制。**

通过 omp 的运行时扩展机制 patch TUI 组件，把设置面板、菜单、状态栏、斜杠命令说明、欢迎屏等界面文案实时翻译为中文。模型侧提示词与工具描述保持英文原文，不影响 agent 行为。

## 截图

| 欢迎屏 | 斜杠命令 | 设置面板 |
|---|---|---|
| ![欢迎屏](screenshots/screenshot-welcome.png) | ![斜杠命令](screenshots/screenshot-commands.png) | ![设置面板](screenshots/screenshot-settings.png) |

## 安装

### 方式一：Marketplace（推荐）

在 omp 会话中执行：

```
/marketplace add losewayy/omp-di18n
/marketplace install omp-di18n@omp-di18n
```

### 方式二：Git 直装

```
omp plugin install github:losewayy/omp-di18n
```

### 方式三：手动

把 `omp-di18n/omp-di18n.ts` 和 `omp-di18n/omp-di18n.zh-CN.json` 两个文件放进 `~/.omp/agent/extensions/`，重启 omp 即可。

安装后重启 omp 生效。卸载：`omp plugin uninstall omp-di18n` 或删除上述文件。

## 覆盖范围

- 设置面板全部标签页（选项名 + 描述）
- `/` 斜杠命令菜单的命令说明
- 欢迎屏（欢迎语、提示、最近会话、LSP 状态）
- 底部状态栏与快捷键提示
- 各类选择器/对话框（模型、会话、主题、回溯等 60+ 个组件）
- 状态通知与动态文案（如 `45 skills` → `45 个技能`）

字典约 1700 条，已逐条审校并统一术语。遇到未翻译的界面文案会自动记录到扩展目录下的 `omp-di18n.misses.txt`——欢迎提 issue 附上该文件。

## 会话内命令

| 命令 | 作用 |
|---|---|
| `/di18n` | 查看状态（字典条数、已翻译/未命中统计） |
| `/di18n off` / `/di18n on` | 临时关闭/开启汉化 |
| `/di18n reload` | 修改字典后热重载 |
| `/di18n misses` | 查看未翻译字符串收集位置 |

## 兼容性

- 跟随官方 omp 版本升级，`omp update` 后无需任何操作
- 上游新增 UI 文案最坏情况是显示英文并记入 misses，不会影响功能
- 所有 patch 独立容错，单个失效不影响其余部分
- 已在 omp v18.2.x 上验证（Windows；macOS/Linux 理论一致，欢迎反馈）

## 工作原理

扩展在 omp 启动时加载，patch `pi-tui`/`pi-coding-agent` 导出的 UI 组件渲染入口，按"精确匹配 → 模板匹配 → ANSI 分段 → 动态规则"的顺序查找 `omp-di18n.zh-CN.json` 字典进行替换，并保持终端显示宽度以维持边框对齐。聊天内容类组件（消息、代码、diff）仅做精确匹配，不会误翻模型输出。

## License

MIT。字典部分翻译数据派生自 [oh-my-pi-zh](https://github.com/LiuQingHuaYang/oh-my-pi-zh)（MIT），详见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。
