# WhyFish

AI 辅助的质量问题分析与解决工具，支持问题定义评估、5 Whys、鱼骨图和故障树分析（FTA）。

> Beta 版本。WhyFish 用于辅助问题分析，不替代专业人员的调查、判断和批准。AI 生成内容需结合客观证据复核。

## 使用方式

### Web 版

在本地启动静态服务器：

```bash
npx serve app/
```

`app/` 是可直接部署的发布包，仅包含运行时使用的压缩 CSS、预处理 JavaScript 和静态依赖。

### Windows 桌面版

从 [GitHub Releases](https://github.com/wongjin/whyfish-release/releases) 下载 Windows `setup.exe` 安装包。

未签名的 Beta 安装包可能触发 Windows SmartScreen；请核对发布来源后再决定是否安装。

桌面版使用简体中文安装引导。JSON、Markdown、Word、SVG 和 PNG 导出均使用系统原生“另存为”窗口，并记住上次成功导出的目录。

## 自动构建

- 推送到 `master`：自动构建 Windows NSIS 安装包，并保留为 GitHub Actions artifact。
- 推送 `v*` 标签：自动创建 GitHub Release，并上传 Windows 安装包。
- 也可在 Actions 页面手动运行 `Build WhyFish for Windows`。

桌面端由 Tauri 2 和 Rust 构建，源码位于 `platforms/desktop/src-tauri/`。

## 数据与 API Key

问题、报告和 API Key 均保存在当前浏览器或桌面 WebView 的本地存储中。请勿在公共设备保存敏感密钥，并建议定期导出数据备份。

## License

MIT
