# dsh-compact

**按比例精确触发的上下文压缩闸门**（DeepSeek Harness 插件）。

DSH 原生在窗口用掉约 **67.85%** 时就开始压缩；本插件让它等到你设定的比例（默认 **90%**）。

```
触发点 = floor(窗口 × triggerRatio)      ← 没有固定余量扣减
```

## 为什么需要它

DSH 0.2 把压缩引擎挂在 **agent preset** 里，带出厂默认 `thresholdRatio: 0.8` /
`headroomTokens: 65536`。preset 平面**任何 patch 层都够不到**，所以原生触发点是：

```
min(W × 0.8, W − O − 65536)
```

在 1M 窗口 + 256K 输出预留下 = `min(800000, 678464)` = **678,464 = 67.85%**。
你配置的比例从来不是生效的那一项。本插件绕过该公式，用 `floor(W × ratio)` 做闸门。

实现方式：`agentPresets.serviceFor(agent,'compaction')` 取到 preset 作用域的活引擎，
包住它的 `compactIfNeeded`；阈值以下返回 `null`（引擎不被调用），阈值以上原样交还。
`agent/request-error` 的溢出恢复**永不拦截**。

不改 DSH 配置文件、不改 preset、不写盘（除监视器）。**卸载即完全恢复原生行为。**

## 配置

全部走 profile 的 `cordis.patch.yml`（本插件是纯 host 插件，**没有 GUI 设置面板**）：

```yaml
- id: dsh-compact
  config:
    enabled: true
    routes: '*'
    triggerRatio: 0.9
    minOutputReserve: 0
    dryRun: false
    monitorPath: '<log-dir>/dsh-compact-monitor.jsonl'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `routes` | `'*'` | 生效路由：`provider` 或 `provider/model`，逗号/空格分隔 |
| `triggerRatio` | `0.9` | 窗口用到此比例时压缩，范围 `[0.05, 0.98]` |
| `minOutputReserve` | `0` | 输出保护底线（token）：剩余空间低于它则提前压缩；`0` = 关闭 |
| `dryRun` | `false` | `true` = 只记录判定、**绝不压缩** |
| `monitorPath` | 系统临时目录 | 判定监视器（JSONL）。**空则不写** |

### monitorPath 是必要的

被抑制的检查**既不调用引擎、也不写会话事件**，所以在会话日志里完全不可见。
监视器是唯一的观测通道，每行一条判定：

```json
{"decision":"skip","contextWindow":1000000,"reservedCompletionTokens":256000,
 "thresholdTokens":900000,"nativeThresholdTokens":678464,
 "measuredTokens":14113,"surfaceTokens":11864,"pendingTokens":2249}
```

- `thresholdTokens` = 本插件阈值；`nativeThresholdTokens` = DSH 原生阈值
- **`decision:"skip"` 且 `measuredTokens ≥ nativeThresholdTokens`** 即：插件拦下了一次原生本会执行的压缩

## 安装

**只需在插件页装上，不用改任何配置文件。** schema 默认值即目标配置：
`enabled: true`、`triggerRatio: 0.9`、`routes: '*'`、`minOutputReserve: 0`、`dryRun: false`。

命令行等价写法（CLI 会写 `dependencies` 与 `dsh.profile.bundles`）：

```powershell
dsh plugin --profile web add 'dsh-compact@file:D:/桌面/DSH与自动化/dsh-compact'
```

要改 `triggerRatio` 等值时才需要在 `profiles/<name>/cordis.patch.yml` 加一行
（本插件是纯 host 插件，**没有 GUI 设置面板**）：

```yaml
- id: dsh-compact
  config:
    triggerRatio: 0.9
```

`monitorPath` 默认 `<DSH_HOME>/logs/dsh-compact-monitor.jsonl`，目录会自动创建。

### 关于热插拔

- **配置改动是热的**：`cordis.patch.yml` 由 `profileReload: live` + HMR 的配置监听生效，无需重启。
- **启用/禁用是热的**：插件页的开关会启用/停用该行。
- **改插件源码不是热的**——因为 base bundle 的 `hmr` 行默认 `root: []`（只监听配置，不监听模块）。
  这对本机所有插件一视同仁。若要让源码也热重载，在 profile patch 里放开监听：

  ```yaml
  - id: hmr
    disabled: false
    config:
      root: ['.', 'D:/桌面/DSH与自动化/dsh-compact']
  ```

## 验证状态

- **31 项测试全过**（策略 11 + host 接线 10 + 验收 10）
- **对照实验已通过**（窗口 80000、输出预留 1000，只改插件比例）：

| | A 组 ratio 0.05 | B 组 ratio 0.9 |
|---|---|---|
| 引擎原生阈值 | 13464 | 13464 |
| 插件阈值 | 4000 | 72000 |
| 实测 | 14063 | 14113 |
| 决策 | delegate | **skip** |
| 会话压缩事件 | **有**（start+summary+end） | **无** |

B 组在实测已超过原生阈值的情况下被拦下，引擎零调用；A 组同样实测下引擎真的压了。

**已知局限**：上述对照在 `W=80000` 下完成；真实 1M 部署走同一代码路径，但未在 1M 下观察到压缩。

## 开发中修掉的三个缺陷（都曾让它静默空转）

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `setSource` 整体替换配置 | settings 文档没有 `monitorPath` → 监视器静默失效 |
| 2 | `routedTarget` 只读已记录 envelope | 首个请求前 `config:null` → 闸门永久早退 |
| 3 | 用 `measure(session)` 当压力 | pre-step 时消息未入 surface → **恒为 0，永远放行** |

第 3 个意味着插件在修复前**从未真正抑制过一次压缩**。三个缺陷各有回归测试锁住。

## 测试

```bash
node --test test/policy.test.js test/index.test.js test/acceptance.test.js
```

需要 `@deepseek-ai/schemastery` 可解析。本目录已有 junction 指向 DSH 依赖树；
装进 profile 后由 DSH 自己的依赖树满足（`verifiedWith: 0.2.0-rc.2`）。

## 边界

- 只拦**自动压力检查**；溢出恢复与手动 `/compact` 不受影响
- **不改剪枝**（`dsh-compaction-tool-result-pruner` 是另一个插件）；触发点推后，剪枝也随之推后
- `routes` 为空字符串 = 停用闸门（不干预任何路由），不会回退到 `*`
