# voice-first

一个基于 Pi Agent Core 的本地英语语音教练原型。

当前实现路线：

- LLM：Pi Agent Core + 自定义 OpenAI Responses 模型
- 模型网关：第三方 OpenAI 兼容接口
- STT：ElevenLabs Speech to Text
- TTS：ElevenLabs Text to Speech
- 录音：`ffmpeg` + `avfoundation`
- 播放：`afplay`
- 工具：仅保留 `bash`
- 笔记目录：`/Users/lettery/Documents/zzm/note/English`

## 配置

1. 复制模板配置：

```bash
cp env.example .env
```

2. 在 `.env` 中填写本地密钥和路径。

> `.env` 已被 Git 忽略，不进入版本控制。

## 安装

```bash
npm install
```

## Codex 技能

当前仓库的 Codex 适配改为基于官方 `ComposioHQ/awesome-codex-skills` 技能框架，不再保留之前的 ECC 本地 prompt/skills 同步目录。

1. 安装推荐技能：

```bash
./scripts/install-awesome-codex-skills.sh --default
```

默认会安装：

- `create-plan`
- `codebase-migrate`
- `changelog-generator`

2. 安装后重启 `codex`，然后在项目根目录直接使用这些技能：

```text
Use the create-plan skill before making code changes.
Use the codebase-migrate skill for a larger refactor.
Use the changelog-generator skill after shipping a user-visible change.
```

3. 如果你想安装别的官方技能，也可以显式指定：

```bash
./scripts/install-awesome-codex-skills.sh create-plan gh-fix-ci webapp-testing
```

## 启动开发模式

```bash
npm run dev
```

启动后使用以下命令：

- `r`：开始录音
- `s`：停止录音并处理请求
- `q`：退出程序

## 列出本机音频输入设备

```bash
npm run list-audio-devices
```

当前机器上已经探测到的音频输入设备索引示例：

- `:0` → “lettery”的麦克风
- `:1` → MacBook Air 麦克风
- `:2` → AirPods

如需切换录音设备，修改 `.env` 中的：

```bash
AUDIO_INPUT_DEVICE=:0
```

## 构建

```bash
npm run build
npm start
```

## 当前已验证链路

- 配置加载
- Pi Agent 对话调用
- ElevenLabs TTS 合成
- ElevenLabs STT 转写
- `ffmpeg` 录音设备探测
- CLI 主循环启动与退出

## 当前未完成项

- 持续通话模式
- 实时流式字幕
- 中途打断播报
- 更细粒度的 `bash` 沙箱
- 自动笔记结构整理
