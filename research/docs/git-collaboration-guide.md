# 队内 Git 协作上手说明

> 给 Blue Lifeline 队员的最小可用指南。不需要懂 Git 原理，照做就行。 有任何一步卡住，及时群内交流。

---

## 0. 先明确：需要用 Git的场景


| 要做的事                         | 需要 Git 吗                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| 看代码、看文档、看参数说明                | 不需要，网页上就能看                                                                                   |
| 写一份README文档交给团队（文献综述、术语表、脚本） | **建议用**，这样有版本记录                                                                              |
| 改工具的代码                       | 需要                                                                                           |
| 只是想看工具长什么样                   | 不需要，直接点[在线演示](https://roeslerroy010-sudo.github.io/water-rights-health-resilience/research/) |


**如果你只是想读文档**，不用装任何东西，直接在浏览器打开仓库看即可：
[https://github.com/roeslerroy010-sudo/water-rights-health-resilience](https://github.com/roeslerroy010-sudo/water-rights-health-resilience)

---

## 1. 一次性准备（约 10 分钟）

### 1.1 注册 GitHub 账号

去 [https://github.com](https://github.com) 注册，然后**把用户名发到群里**，队长会把你加为协作者。

你会收到一封邀请邮件，或者在 [https://github.com/notifications](https://github.com/notifications) 看到邀请，**点接受**。没接受之前你没有推送权限。

### 1.2 安装 Git

**Mac**：打开「终端」，输入 `git --version` 回车。

- 如果显示版本号 → 已装好
- 如果弹出安装提示 → 点安装

**Windows**：下载 [https://git-scm.com/download/win](https://git-scm.com/download/win) ，一路默认下一步。装完在开始菜单找到「Git Bash」，之后所有命令都在 Git Bash 里敲。

### 1.3 告诉 Git 你是谁

只做一次。把引号里换成你自己的：

```bash
git config --global user.name "你的名字"
git config --global user.email "你注册 GitHub 用的邮箱"
```



### 1.4 把项目下载到本地

`cd` 到你想放项目的地方（比如桌面），然后：

```bash
git clone https://github.com/roeslerroy010-sudo/water-rights-health-resilience.git
```

会多出一个 `water-rights-health-resilience` 文件夹，**之后所有命令都要先进到这个文件夹里再执行**：

```bash
cd water-rights-health-resilience
```

> 第一次推送时可能要求登录。GitHub 现在不接受账号密码，需要用 **Personal Access Token**：
> GitHub 网页 → 右上角头像 → Settings → Developer settings → Personal access tokens →
> Tokens (classic) → Generate new token → 勾选 `repo` → 生成后**把那串字符存下来**，
> 命令行让你输 password 时粘贴它（输入时屏幕不显示是正常的）。

---



## 2. 日常四步（90% 的时间只用这四条）

每次开始干活之前，**先拉最新**：

```bash
git pull
```

改完文件之后，三步提交：

```bash
git add .                          # 把改动放进待提交区
git commit -m "简单说明你改了什么"    # 存一个版本
git push                           # 推到 GitHub
```

就这么多。`git status` 随时可以看当前状态，看不懂就截图发群里。

### 提交说明怎么写

写清楚「改了什么」，中文即可（可以直接在cursor, VSCode, Github Desktop等界面要求AI辅助写作）：

- ✅ `docs: 补充工业水污染健康负担的文献综述`
- ✅ `docs: 界面英文术语对照表初稿`
- ❌ `update`、`修改`、`1`

---



## 3. 建议的协作方式：开分支 + Pull Request

`main` 分支设了保护，**不能直接推**，需要走 Pull Request（简称 PR）。这不是麻烦，是防止误操作把别人的东西覆盖掉。

```bash
git pull                                    # 1. 先同步最新
git checkout -b docs/health-literature      # 2. 开一个自己的分支
# ……改文件……
git add .
git commit -m "docs: 健康剂量-反应文献初稿"
git push -u origin docs/health-literature   # 3. 推自己的分支
```

推完终端会打印一个链接，**点它** → 页面上点 `Create pull request` → 写两句说明 → 提交。

队长（或任一队友）在网页上点 Approve 后就能合并。合并后你本地回到主线：

```bash
git checkout main
git pull
```



### 分支起名建议


| 你做的事  | 分支名        |
| ----- | ---------- |
| 写文档   | `docs/xxx` |
| 改界面文案 | `i18n/xxx` |
| 修 bug | `fix/xxx`  |
| 加功能   | `feat/xxx` |


---



## 4. 各自把文件放哪（分工暂定）


| 队员  | 内容                       | 放这里                            |
| --- | ------------------------ | ------------------------------ |
| 弘宇  | 文献综述、参数出处、剂量—反应估计、不确定性区间 | `research/docs/`               |
| 渝山  | 英文术语对照表、视频脚本、界面英文文案      | `research/docs/`               |
| 成旭  | 代码                       | `research/js/`、`research/css/` |


**先读这两份**（clone 下来就有）：

- `research/docs/calculation-guide.md` —— 模型计算口径全说明。**第 9 节**列出了所有目前没有文献出处的参数，弘宇的工作从这一节开始。
- `research/docs/methodology.md` —— 方法论决策（为什么这样建模）。

---



## 5. ⚠️ 仓库是公开的，这几类东西不要提交

任何人都能在网上看到这个仓库，所以：

- ❌ **手机号、身份证号、家庭住址**
- ❌ **报名表原件**（里面有队长手机号和大家的个人信息）
- ❌ 密码、API key、任何 token
- ❌ 大文件（PPT、视频、压缩包）——仓库会变得很慢

**PPT、报名表这些材料走微信或网盘发**，不进仓库。仓库只放代码和不含个人信息的文档。

如果不确定某个文件能不能提交，**先在群里问一句**。已经推上去的东西即使删掉，历史记录里仍然查得到，清理很麻烦。

---



## 6. 出问题了怎么办



### 「我不小心改乱了，想退回去」

**还没 commit**，想丢弃某个文件的改动：

```bash
git checkout -- 文件名
```

⚠️ 这会**永久丢弃**你对该文件未保存的改动，确认不要了再执行。

### 「push 被拒绝，说 rejected」

通常是别人先推了新东西。先拉再推：

```bash
git pull --rebase
git push
```



### 「出现一堆 `<<<<<<<` `=======` `>>>>>>>`」

这是冲突——你和别人改了同一个地方。**不要慌，也不要乱删**，把文件名发群里，让队长帮你处理。

### 「完全乱了，想重来」

最省事的办法：把整个文件夹删掉，重新 `git clone` 一份。**但删之前先把你改过的文件复制出来备份。**

---



## 7. 不想用命令行？

可以用图形界面，功能一样：

- **GitHub Desktop**（推荐，最简单）：[https://desktop.github.com](https://desktop.github.com)
装完登录账号 → File → Clone repository → 选我们的仓库。之后改文件、写说明、点 Commit、点 Push，全是按钮。
- **VS Code** 自带 Git 面板，如果你已经在用它写东西，左侧第三个图标就是。

**用图形界面完全没问题**，本文档的命令只是给习惯终端的人看的。

---



## 常用命令速查

```bash
git pull                      # 拉最新（每次开工前必做）
git status                    # 看当前状态
git add .                     # 暂存所有改动
git commit -m "说明"          # 提交
git push                      # 推送
git checkout -b 分支名        # 新建并切换分支
git checkout main             # 切回主分支
git log --oneline -5          # 看最近 5 条提交
```

