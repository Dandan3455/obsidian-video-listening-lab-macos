# Obsidian 视频口语精听

一个面向英语精听的 Obsidian 桌面插件：从 YouTube 或 Bilibili 的公开英文字幕轨生成带时间戳的 Markdown 稿件，并提供内嵌播放器、字幕跟随、逐句跳转和通勤复听音频导出。

## 主要功能

- 导入 YouTube 人工英文字幕；没有人工字幕时使用自动英文字幕。
- 在 Bilibili 视频公开提供英文字幕轨时导入该轨道。
- 使用 DeepSeek 对字幕进行一次断句和轻量清理，再生成最终笔记。
- 在 Obsidian 右侧维持一个播放器，点击段落或句首时间戳即可跳转。
- 播放时自动滚动并高亮当前句。
- 支持只读精听稿，降低误编辑概率。
- 将当前精听材料导出为 M4A，保存到 OneDrive，方便同步到 iPhone。

## 快捷键

- `←`：上一句。
- `↓`：回到当前句开头并继续播放。
- `→`：下一句。
- `Space`：播放或暂停。
- `Alt+R`：从当前句开头重播。

## 环境要求

- Windows 桌面版 Obsidian。
- Python 3.10 或更高版本。
- `yt-dlp` 和 `imageio-ffmpeg`。
- DeepSeek API Key。导入字幕时会调用一次 DeepSeek；播放、字幕跟随和音频导出不调用 AI。
- 如需自动同步复听音频，需要本机存在 `~/OneDrive` 文件夹。

## 安装

1. 下载本仓库，将文件夹命名为 `youtube-listening-lab`。
2. 把整个文件夹复制到你的 Obsidian 库：

   ```text
   <你的库>/.obsidian/plugins/youtube-listening-lab/
   ```

3. 双击运行 `install_dependency.cmd` 安装本地依赖。
4. 在 Obsidian 的“第三方插件”设置中启用“视频口语精听”。
5. 在插件设置中填入 DeepSeek API Key。

API Key 只保存在本机插件目录的 `data.json` 中；该文件已被 `.gitignore` 排除。当前版本采用 Obsidian 社区插件常见的本地明文配置方式，请自行保护电脑和 Obsidian 库。

## 使用

1. 点击 Obsidian 左侧栏的耳机图标。
2. 粘贴 YouTube 或完整 Bilibili 视频链接；可选填开始和结束时间。
3. 等待字幕提取和 DeepSeek 清理完成。
4. 在生成的精听稿中点击时间戳或句首 `▶` 播放。
5. 打开当前精听稿后，点击播放器栏的“导出复听音频”，或在命令面板运行“导出当前精听稿复听音频”。

## 数据与 Token

- 字幕提取、时间戳对齐、播放器控制和音频导出均在本地完成，不消耗模型 Token。
- DeepSeek 只处理新导入的视频字幕；字幕文本会发送到 DeepSeek API。
- 插件不会上传你的 Obsidian 笔记。

## 已知限制

- 发布者禁止第三方嵌入的视频只能在默认浏览器中播放，无法在 Obsidian 内同步进度。
- Bilibili 仅支持公开英文字幕轨，不能识别烧录在画面里的字幕。
- 当前音频导出位置固定为 OneDrive 下的 `口语精听复听` 文件夹。
- 这是桌面插件，不支持 Obsidian Mobile。

## 仓库文件

- `main.js`：Obsidian 插件主体。
- `manifest.json`：插件清单。
- `styles.css`：播放器和字幕高亮样式。
- `youtube_to_obsidian.py`：本地字幕提取与音频导出器。
- `install_dependency.cmd`：Windows 依赖安装脚本。

