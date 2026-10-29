# 市场收录目录（Awesome DSH Plugin Submission）

本目录存放本项目提交到 [Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 注册表的条目**镜像**与操作说明。正式数据在对方仓库的 `data/plugins/` 里，本目录只是本地对照。

## 当前状态

- **条目已收录**：PR [#3812](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/3812) 已于 **2026-08-30 合并**（merge commit `c079c705`），线上文件是 `data/plugins/dingminhua__dsh-connect-workbuddy.yml`。
- **正在更新**：PR [#10281](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10281) —— 把条目描述从 **2.0.15 时期的版本**更新到当前能力，并补 `icon:` 字段。**这条更新暴露的问题值得记住**：条目合并后就不会自己更新，插件加了新功能而描述没跟上，注册表上挂的就是过期声明；而注册表评审明确「描述必须属实、会对着代码核」，所以**每次有大的能力变化时，条目也要跟着提一次 PR**。
- **截图**：声明在**本项目自己仓库**的 [`screenshots.json`](../screenshots.json)，未修改注册表 `data/screenshots.json`（该文件是旧约定回退，禁止再加新键）。

## 收录目录规范（依据 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)）

- 每个插件一个 YAML：`data/plugins/<owner>__<repo>.yml`
- 字段：
  - `url`：与仓库地址**完全一致**
  - `name`：`owner/repo`
  - `category`：有效值之一（本项目为 `model`）
  - `description.en`：必填，一行，以句号结尾；含 `: ` 必须加引号
  - `description.zh`：可选，维护者会补
  - `icon`：可选，**必须 GitHub 托管的位图**（png/jpg/jpeg/webp），SVG 与第三方图床会被拒；本项目指向 `icons/dsh-connect-workbuddy-128.png`
  - `tarball`：可选，本项目已发布 npm，用不到
- 前置要求：
  - 仓库 `package.json` 声明 `dsh.bundle` manifest（本项目 `dsh.bundle.patch: ./cordis.patch.yml`）；**只声明 `dsh.client` 是最常见的被拒原因**
  - 仓库打 `dsh-plugin` topic（本项目已有）
  - 仓库创建**满 1 天**。**没有提交数门槛**——历史上那条已废除（见对方 #4196：历史长短反映开发习惯而非质量）
- 两个 README 由脚本生成，**不要手工编辑**（手工编辑会因行号移位落到邻居条目上）。本地预览：
  ```sh
  npm ci
  node scripts/generate-readme.mjs
  ```
- 一个 PR 最多 3 条；**只改自己的条目**——改了别人的条目是评审会直接追问的事项。
- **条目合并之后不会自己更新**：插件有大的能力变化时，描述要另开一次 PR 跟上（本项目 2026-10-29 提的是 [#10281](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/10281)，把 #3812 停留在 2.0.15 的描述更新到当前能力并补 `icon:`）。

## 评审口径（决定我们该怎么写描述）

- **CI 绿是前置条件，不是结论**：CI 只校验形式（manifest、仓库年龄、格式、README 能否重新生成），判断不了描述是否属实。合并前维护者会实际读目标仓库。
- **描述必须属实**：写「46 个工具、六大领域」就应该真有 46 个工具和六个领域；提到某个命令或 API，它就应该存在。**夸大是让一个本来不错的插件被打回的主要原因。**
- 分类选贴近实际的即可，选得不准维护者会直接改，不会打回。
- 被打回时反馈会以 PR 评论给出具体要改什么；打上 `held: author` 标签只是暂停在合并队列里，**不是拒绝**。
- **不要反复催**：推修复到同一分支 + 留**一条**说明改了什么，就是全部信号。反复推送或连发追问都不会更快；状态可在对方每天 06:19 UTC 刷新的「Held pull requests that may have healed」跟踪 issue 里自查。

## 更新步骤（改条目内容时）

1. 修改本目录的 `dingminhua__dsh-connect-workbuddy.yml` 镜像
2. 从**同步过 upstream main 的** fork 分支上改 `data/plugins/dingminhua__dsh-connect-workbuddy.yml`（只改这一个文件）
3. 推送并开 PR；CI 自动跑，**不要手工编辑两个 README**
4. 若 CI 红在 `READMEs match data/plugins`，那是分支快照落后，维护者合并时会重新生成，**不归我们修**

> 分支名按事项取即可（本次更新用的是 `update-workbuddy-market-description`，与首次提交的 `add-dsh-connect-workbuddy` 不是同一条）。
