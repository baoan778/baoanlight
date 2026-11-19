# 第三方声明

本项目以 MIT 许可发布（见 [LICENSE](LICENSE)）。随包分发的第三方代码与其许可如下。

## three.js

随渲染器和落地页一起分发的 three.js 构建文件：

- `src/overlay/vendor/three.core.js`
- `src/overlay/vendor/three.module.js`
- `docs/demo/vendor/three.core.js`
- `docs/demo/vendor/three.module.js`

其版权与许可：

```
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## npm 依赖

`@modelcontextprotocol/sdk`、`zod` 以及可选的 `electron`、`node-pty` 等依赖由 npm
在安装时单独下载，各自的许可文件随包分发，不在本仓库中重复收录。它们均为 MIT、
Apache-2.0、BSD 或 ISC 等宽松许可。

## 商标

Claude、Claude Code、Codex、DeepSeek、WorkBuddy、CodeBuddy、Cursor、GitHub Copilot、
Gemini、Aider、Qwen、Kimi 等名称与商标归其各自所有者。本项目仅用于描述兼容性，
与上述公司或产品没有隶属、赞助或背书关系。
