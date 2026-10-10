# 长文本粘贴优化 · SillyTavern 插件 0.1.0

用于手机浏览器里“一次粘贴大段文本，酒馆页面停住，几秒甚至半分钟后文本才出现”的问题。默认从 4096 个 UTF-16 代码单元开始启用长文本处理，阈值可在扩展设置中调整。

这次交付是客户端扩展，不修改酒馆核心源码。不需要额外安装 Node 依赖或服务端插件。

## 手机 Termux 安装

### 离线安装脚本

1. 下载随插件交付的 `install-long-paste.cjs`，放在手机 Download 文件夹。
2. 若 Termux 尚未有存储权限，运行 `termux-setup-storage` 并在手机弹窗中允许。
3. 在 Termux 进入酒馆安装目录，目录中应有 `package.json` 和 `public`。例如常见目录：

```sh
cd ~/SillyTavern
node /sdcard/Download/install-long-paste.cjs
```

安装目录不同，就替换 `cd` 的路径。脚本只写入自己的扩展目录，已有同名目录时会停止，避免覆盖你的修改。

4. 按平时方式重启酒馆，清除浏览器对酒馆的缓存文件，再重新打开。不要清除网站数据。
5. 打开扩展设置，确认出现“长文本粘贴优化 · 0.1.0”，并且“自动补全保护”显示“可用”。默认启用。

### ZIP 手动安装

将 `st-long-paste.zip` 解压到酒馆的 `public/scripts/extensions/third-party` 目录。正确结构应为：

```text
SillyTavern/public/scripts/extensions/third-party/st-long-paste/manifest.json
SillyTavern/public/scripts/extensions/third-party/st-long-paste/index.js
SillyTavern/public/scripts/extensions/third-party/st-long-paste/paste-engine.js
```

例如已安装 unzip 的 Termux 可在酒馆根目录执行：

```sh
mkdir -p public/scripts/extensions/third-party
unzip /sdcard/Download/st-long-paste.zip -d public/scripts/extensions/third-party
```

这是“所有用户”扩展位置。它也可按官方扩展方式安装到 `data/<用户目录>/extensions/st-long-paste`；不要在两个位置重复安装。

## 使用

安装后照常长按粘贴，不需要手动分段。默认处理普通文本框、文本区、动态弹出的输入框，以及可访问的同源内嵌页面。

- 长文本用 `setRangeText` 按当前选区一次填入，保留前后已有文本和插入后的光标位置。
- 跳过这次粘贴的原生默认路径，在页面有机会绘制后发送一次 `input` 通知，让酒馆读取完整值。
- 文本超过阈值时，共用自动补全组件停止扫描和解析整段内容；输入法组字期间也暂停补全。
- 长文本输入区域临时关闭拼写检查和自动纠正，缩短文本或关闭插件后恢复。
- 不分段插入，不主动截断内容，不改写角色卡、预设、聊天文件、正则或美化。
- 插件没有网络请求，也不在本地存储里保存粘贴文本。剪贴板只在用户粘贴时读取。

粘贴后会出现“撤销”按钮。扩展设置也有“撤销本次粘贴”；Ctrl+Z 和可取消的移动端 `historyUndo` 输入事件同样支持撤销最近一次接管的粘贴。

**接管粘贴使用程序化文本替换，浏览器原有的粘贴撤销历史可能不同。插件提供单次撤销。**撤销记录保留两分钟；若你已经继续修改文本，插件会拒绝整次回滚，避免覆盖后续编辑。可在设置里关闭“接管长文本粘贴”，保留自动补全保护。

## 设置

扩展面板中可独立控制总开关、接管粘贴、自动补全保护、拼写检查优化和长文本阈值。开关立即生效。

“长聊天初始加载 50 条”按钮通过酒馆自己的设置接口修改初始消息显示数，重新打开聊天后生效。历史记录保留。这不是持续裁剪或完整虚拟滚动；继续加载旧楼层会继续增加页面节点。

如之前已经安装了本次聊天早先提供的核心源码补丁，请先用该补丁脚本的 `--restore` 回滚，再测试插件，方便判断插件本身效果。

## 关闭与删除

关闭插件自己的“启用插件”开关，会解除输入监听、恢复自动补全方法和插件修改的拼写属性。也可在酒馆的管理扩展中禁用后刷新。

删除时只删除 `st-long-paste` 扩展文件夹，再刷新酒馆。不需要恢复核心源码。

## 验证与适用范围

已通过 36 项自动化逻辑检查：大段 Unicode 文本、选区替换、连续粘贴、输入通知合并、保存前通知、撤销、后续编辑保护、输入法组字、同源 iframe、启停恢复等，并通过 JavaScript 语法检查。

这些是模型化的输入事件和字段测试。当前环境无法完成真实浏览器连接测试，也未连接你的手机；因此尚未验证你手机上实际冻结时间是否消失。请先用你之前会卡住的同一段文本，在原来的输入位置复测。

普通聊天输入框、角色描述和预设文本区是主要目标。富文本编辑器、CodeMirror/Monaco、自定义编辑器、跨域 iframe、密码字段、文件粘贴和有明确长度限制的字段保留原行为。第三方监听若只接受 `isTrusted` 事件，可能不接受程序化输入通知；遇到保存不同步时关闭“接管长文本粘贴”，保留自动补全保护。

扩展设置会显示本次“填入用时”和“输入监听执行用时”，只包含长度和耗时。如果仍卡住，这两个数能帮助判断耗时发生在哪一步。后续监听仍会正常执行；插件没有无差别禁用其他扩展的保存或输入处理，不能保证任意第三方脚本或浏览器内核的耗时都被消除。

## 源码依据

- [SillyTavern 扩展接口与安装位置](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [1.19.0 共用自动补全组件](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/autocomplete/AutoComplete.js)
- [1.19.0 宏自动补全入口](https://github.com/SillyTavern/SillyTavern/blob/1.19.0/public/scripts/autocomplete/MacroAutoComplete.js)
- [浏览器 setRangeText](https://developer.mozilla.org/en-US/docs/Web/API/HTMLTextAreaElement/setRangeText)

MIT License。
