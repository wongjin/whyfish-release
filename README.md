# WhyFish — Problem-Solving Copilot

**AI 辅助的质量问题分析与解决工具**，支持 5 Whys、鱼骨图、故障树分析 (FTA)。

> **Beta 版本。** WhyFish 用于辅助问题分析，不替代专业人员的调查、判断和批准。
> AI 生成内容可能不完整或不准确，请结合客观证据复核。

---

## 使用方式

### 方式一：桌面 exe（推荐）

从 [Releases](https://github.com/wongjin/whyfish-release/releases) 下载 \whyfish.exe\，双击即可运行。
> 系统弹出 SmartScreen 警告时，点击 **"更多信息" → "仍要运行"** 即可。

### 方式二：浏览器

\\\ash
npx serve app/
\\\

或用任意 HTTP 服务器托管 \pp/\ 目录，浏览器打开访问。

---

## 功能

- **问题结构化定义** — 5W2H 模板 + AI 工具匹配建议
- **5 Whys 分析** — 树状多分支因果链推演，AI 辅助生成/校验
- **故障树 FTA** — 逻辑门建模、SVG 图形视图、ASCII 文本视图
- **鱼骨图分析** — 5M1E 多维度原因发散，AI 一键填充
- **报告管理** — 本地保存分析快照，支持 Markdown/Word 导出
- **多主题** — 翠绿/莓红/靛蓝/雾蓝 四种主题切换

---

## AI 模型配置

在设置面板填入 API Key 即可使用 AI 功能：

| 服务商 | 说明 |
|---|---|
| **DeepSeek** | 默认推荐，高性价比推理 |
| **OpenAI** | ChatGPT 系列 |
| **Anthropic** | Claude 系列 |
| **自定义** | 兼容 OpenAI 格式的任意端点 |

> API Key 仅保存在本地，不会上传到任何第三方服务器。

---

## 数据存储

所有数据（问题库、分析记录、API Key、主题设置等）保存在浏览器本地存储中。

**exe 版数据路径：**
\\\
C:\Users\<用户名>\AppData\Local\com.whyfish.desktop\EBWebView\Default\Local Storage\leveldb\
\\\

> 卸载 exe 不会自动删除这些数据，需手动清理。建议定期在设置页面导出备份。

---

## License

MIT
