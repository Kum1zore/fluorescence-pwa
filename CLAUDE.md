# CLAUDE.md — 荧光检测平台项目指引

## 项目简介

这是一个运行在安卓手机上的荧光强度检测 PWA（渐进式网页应用）。目标用户是不懂编程的实验室研究人员，用于硫磺素 T (ThT) 荧光实验芯片的定量分析。

## 文档索引

所有项目规范文档位于 `docs/` 文件夹，修改代码前请先阅读对应文档：

| 文档 | 路径 | 何时阅读 |
|------|------|----------|
| 开发需求 | [docs/requirements.md](docs/requirements.md) | 不确定某个功能应该如何工作时 |
| 技术规范 | [docs/tech-spec.md](docs/tech-spec.md) | 涉及模块职责、API 设计、存储结构时 |
| 设计规范 | [docs/design-spec.md](docs/design-spec.md) | 涉及颜色、字体、间距、组件样式时 |
| 图像算法 | [docs/image-algorithms.md](docs/image-algorithms.md) | 修改或调试图像处理代码时 |
| 执行计划 | [docs/execution-plan.md](docs/execution-plan.md) | 开始新阶段工作前，查看当前进度和下一步 |

## 工作流程

### 每次开发会话

1. **开始前**：打开 [docs/execution-plan.md](docs/execution-plan.md)，确认当前处于哪个阶段
2. **编码中**：只做当前阶段的任务，不跨阶段编写后续阶段的代码
3. **完成后**：
   - 勾选 `execution-plan.md` 中对应任务项
   - 更新 `devlog/YYYY-MM-DD.md`（当天日期文件，不存在则新建）

### 开发日志格式

```markdown
# 开发日志 — YYYY年M月D日

## ✅ 完成事项
- [x] 具体完成的事情

## 📋 待办事项
- [ ] 下次需要做的事

## ⚠️ 遇到的问题
- 问题描述 + 解决方式

## 📌 备注
- 其他说明
```

## 核心约束

1. **逐个阶段推进**：每阶段完成并验证通过后，才能进入下一阶段
2. **不一口气写全部代码**：禁止一次性创建所有 JS 文件并填充完整实现
3. **每个功能点验证后再继续**：写完一个模块后，确认它能正常工作再写下一个
4. **参考规范文档**：颜色用 `docs/design-spec.md` 中的色值，算法用 `docs/image-algorithms.md` 中的伪代码
5. **文件放 D 盘**：所有项目文件在 `D:\fluorescence-pwa\` 下

## 技术约束

- 纯 HTML/CSS/JS，不引入任何框架或 npm 依赖
- 不使用 ES modules（`import`/`export`），用 `<script>` 标签按依赖顺序加载
- 所有图像处理在 Canvas 上完成，不上传任何数据
- 存储使用 IndexedDB，不依赖任何服务器

## 项目结构速查

```
D:\fluorescence-pwa\
├── CLAUDE.md              ← 本文件
├── docs/                  ← 规范文档（先读这里）
│   ├── requirements.md
│   ├── tech-spec.md
│   ├── design-spec.md
│   ├── image-algorithms.md
│   └── execution-plan.md
├── devlog/                ← 开发日志
├── index.html
├── manifest.json
├── sw.js
├── css/style.css
├── js/
│   ├── constants.js
│   ├── ui.js
│   ├── camera.js
│   ├── roi.js
│   ├── imageProc.js
│   ├── pseudocolor.js
│   ├── storage.js
│   ├── results.js
│   └── app.js
└── icons/
```
