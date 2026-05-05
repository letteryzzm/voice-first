# voice-first 语音交互优化完整 TODO（基于 Pipecat 代码审计）

- 日期：2026-05-02
- 状态：待审查，审查通过后分阶段实现
- 参考项目：`/Users/lettery/Documents/code/pipecat/`
- 当前项目：`voice-first`
- 目标：把当前“手动录音 -> 整段 STT -> Agent -> 整段 TTS -> 播放”的 V1，逐步升级为安全、可测试、可观测、低延迟、可打断的语音交互系统。

## 0. 当前 voice-first 基线

当前实现是清晰的 V1 批处理闭环：

- CLI 状态机在 `src/runtime/voiceCoachApp.ts:10` 定义 `idle/recording/transcribing/thinking/executing bash/speaking/done/error`。
- CLI 手动 `r/s/q` 控制在 `src/runtime/voiceCoachApp.ts:42`。
- 单轮处理链路在 `src/runtime/voiceCoachApp.ts:90`：停止录音、STT、Agent、TTS、播放。
- 录音使用 ffmpeg 子进程，见 `src/audio/ffmpegRecorder.ts:22`。
- STT/TTS 使用 ElevenLabs，见 `src/providers/elevenlabs.ts:22` 和 `src/providers/elevenlabs.ts:40`。
- Agent 当前暴露通用 `bash` 工具，见 `src/tools/bashTool.ts:35`；风险点是 `bash -lc` 执行模型生成命令，见 `src/tools/bashTool.ts:45`。

这个基线可以继续保留，但下一步必须先补安全、测试、生命周期，再考虑实时化。

## 1. Pipecat 语音交互主流问题与代码依据

### 1.1 VAD / 语音活动检测

主流问题：噪声误触发、短暂停顿误判结束、麦克风静音或断流后无法自动收口。

Pipecat 做法：

- VAD 参数独立配置，包括 `confidence/start_secs/stop_secs/min_volume`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:24` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:46`。
- VAD 状态机不是 boolean，而是 `QUIET -> STARTING -> SPEAKING -> STOPPING`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:30`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:149`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:189`。
- 音频先按帧缓冲，再结合模型置信度和音量门限判断 speaking，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:197`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:201`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_analyzer.py:206`。
- VADController 将 VAD 状态变成 started/stopped/activity 事件，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_controller.py:31`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_controller.py:135`。
- 对用户说话中麦克风断流，使用 `audio_idle_timeout` 强制触发 speech stopped，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_controller.py:70`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_controller.py:194`、`/Users/lettery/Documents/code/pipecat/src/pipecat/audio/vad/vad_controller.py:209`。

对 voice-first 的启发：V1 可继续手动 stop；实时模式前必须有可替换 VAD Analyzer、去抖状态机、音量门限、idle timeout。

### 1.2 Turn detection / 用户回合判断

主流问题：只靠静音会抢答；STT final 延迟会导致等待过久；上一轮迟到转写会污染下一轮。

Pipecat 做法：

- turn start/stop 采用策略组合，默认 start 使用 VAD + transcription fallback，stop 使用 turn analyzer，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_strategies.py:25`、`/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_strategies.py:41`、`/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_strategies.py:50`。
- VAD start 可立即开始 user turn；如果 VAD 漏检，转写帧也能触发 start，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_start/vad_user_turn_start_strategy.py:31` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_start/transcription_user_turn_start_strategy.py:38`。
- stop 侧结合音频、VAD、转写，VAD stop 后等待 final transcription 或 STT P99 timeout，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:32`、`/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:130`、`/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:201`。
- VAD 的 `stop_secs` 已经消耗了一段静音，所以 STT 等待用 `stt_timeout - stop_secs` 抵扣，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:172`。
- 如果 STT 明确 finalized，则立即触发 stop，不再等 timeout，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:205` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:266`。
- controller 在 turn start 时重置 stop strategies，防 late transcription 污染下一轮，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_controller.py:257`、`/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_controller.py:277`、`/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:203`。

对 voice-first 的启发：下一阶段不要直接跳到“持续录音自动停止”，先定义 `TurnController`，把手动 stop、VAD stop、STT final、timeout 都抽象成策略。

### 1.3 Barge-in / Interrupt / 用户打断

主流问题：用户说话时机器人还在播；LLM/TTS/播放器继续产生旧输出；旧音频或旧文本泄漏到下一轮。

Pipecat 做法：

- 核心协议是 `InterruptionFrame`，语义是用户开始说话后取消当前 bot output，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:908`。
- `UserTurnProcessor` 在 user turn started 后广播 `UserStartedSpeakingFrame`，再按策略广播 interruption，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_processor.py:177` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/turns/user_turn_processor.py:182`。
- `FrameProcessor` 收到 interruption 后停止 metrics，并清理可中断队列；如遇 `UninterruptibleFrame` 则保留不可中断内容，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:608`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:816`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:822`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:829`。
- 输出 transport 收到 interruption 会清音频队列，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:523`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:529`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:533`。
- TTS 收到 interruption 会清 text aggregator、filters、word timestamps、audio contexts，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:850`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:862`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:867`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:870`。

对 voice-first 的启发：如果不建立统一 interruption 协议，连续语音模式一定会出现“旧回复继续播”和“下一轮混入旧输出”。

### 1.4 Frame pipeline / 优先级与取消模型

主流问题：实时语音系统中 cancel/error/interrupt 必须插队；普通音频和文本可以取消；结束帧不能丢。

Pipecat 做法：

- Frame 分为 `SystemFrame`、`DataFrame`、`ControlFrame`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:94`、`/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:105`、`/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:117`。
- `UninterruptibleFrame` 保证 terminal frame 不被打断丢弃，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:136` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:1497`。
- 每个 processor 有优先级队列：SystemFrame priority=1，普通 frame priority=2，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:81`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:99`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:111`。
- processor 内部区分 input task 和 process task，system frame 立即处理，普通 frame 排队处理，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:207`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:223`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:965`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:993`。
- Pipeline 是 source -> processors -> sink 的线性链，支持 downstream/upstream，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/pipeline.py:91`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/pipeline.py:119`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/pipeline.py:192`。

对 voice-first 的启发：当前 V1 不需要完整 Pipecat 级 pipeline，但必须先设计最小 frame/event 协议，避免后续把实时能力硬塞进 `VoiceCoachApp` 状态机。

### 1.5 Streaming STT

主流问题：连续音频流如何切段；bot 讲话时如何避免自转写；STT final latency 如何度量；连接断开如何不丢用户音频。

Pipecat 做法：

- `STTService` 是连续音频处理基类，每个音频帧调用 `run_stt(frame.audio)`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:47`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:276`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:397`。
- 支持 `STTMuteFrame`，bot 讲话时丢弃输入，避免回声/自转写，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:1098` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:430`。
- STT TTFB 从用户实际停止说话到 final transcript 到达，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:101`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:540`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:544`。
- STT metadata 广播 P99 final transcript latency，给 turn strategy 动态调等待，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:468` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:474`。
- `SegmentedSTTService` 基于 VAD 分段，说话时累计 buffer，安静时保留 pre-roll，VAD stop 后整段 STT，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:683`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:741`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:747`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:780`。
- WebSocket STT 有 keepalive 和重连，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:789`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:817`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:636`。

对 voice-first 的启发：V1 的整段 STT 可保留；P2 再实现 `SegmentedSTT`，不要一开始就全流式。

### 1.6 Streaming TTS / 音频上下文排序

主流问题：文本和音频乱序；TTS 首包延迟高；打断后旧音频继续播；结尾音频被截断。

Pipecat 做法：

- TTS 聚合模式支持按句和按 token；按句自然但增加约 200-300ms，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:75`。
- `TTSService` 先聚合、过滤、transform，再 `run_tts(text, context_id)`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:632`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:880`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:894`。
- `AggregatedTextFrame` 放进 serialization queue，保证说明文本和音频顺序一致，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:967`。
- 每个 audio context 内按 FIFO 处理 `TTSStartedFrame/TTSAudioRawFrame/TTSTextFrame/TTSStoppedFrame`，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1163`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1267`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1285`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1336`。
- 首个 TTS audio chunk 到达时停止 TTS TTFB，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1359`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:1362`。
- TTS stopped 后可追加静音，避免结尾被 transport 截断，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/tts_service.py:773`。

对 voice-first 的启发：即使 V1 仍然整段 TTS，也应引入 `speakContextId` 和 TTS lifecycle event，为后续 streaming/interrupt 打基础。

### 1.7 Audio transport / jitter / buffering

主流问题：音频生成速度和真实播放速度不同；包太大导致打断迟钝；包太小增加开销；输出 buffer 需要可清理。

Pipecat 做法：

- Transport 参数集中管理采样率、声道、10ms chunk 数等，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_transport.py:25` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_transport.py:59`。
- 输出统一切成 `10ms * audio_out_10ms_chunks`，默认约 40ms，利于 interruption，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:82` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:119`。
- 输出会重采样并 chunk 后入队，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:557` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:563`。
- bot speaking 不只依赖 TTS 事件，也可通过输出音频静音判断，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:55` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_output.py:698`。
- WebSocket output 模拟真实音频设备发送节拍，并支持固定 packet buffer，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:361`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:396`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:501`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:520`。
- 本地音频用 PyAudio callback 采集 20ms 输入，输出写入放 executor，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/local/audio.py:79`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/local/audio.py:103`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/local/audio.py:174`。

对 voice-first 的启发：当前 `afplay` 整段播放无法真正 barge-in；要实现中途打断，需要替换为可控制的 chunk player 或子进程可取消播放器。

### 1.8 Task lifecycle / cancellation / backpressure

主流问题：启动顺序错乱；取消时挂死；关闭过程中仍接收新 frame；长时间 idle 不退出。

Pipecat 做法：

- `PipelineTask` 统一配置 StartFrame、metrics、heartbeat、idle timeout、turn tracking，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:106` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:190`。
- task 启动时先 setup processor，再创建 push queue task；外部取消转为内部 CancelFrame，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:522`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:539`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:542`。
- StartFrame 到达 pipeline 末端后才继续推业务 frame，避免未初始化就处理，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:763` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:775`。
- End/Cancel/Stop/Interruption task frame 被转换为 downstream frame，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:804`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:808`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:812`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:816`。
- heartbeat 和 idle monitor 监控卡住或空闲，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:875`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:884`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:904`、`/Users/lettery/Documents/code/pipecat/src/pipecat/pipeline/task.py:920`。
- processor cancellation 设置 `_cancelling` 后不再接收新 frame，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:196`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:554`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:785`。
- cancel 带 timeout，防止第三方库吞掉取消导致挂死，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:132`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:473`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:897`。

对 voice-first 的启发：即使不做完整 pipeline，也要补 `cleanup()`、abort signal、timeout、running/closing 状态，防止子进程和 API 请求悬挂。

### 1.9 Error / reconnect

主流问题：错误没有上下文；WebSocket 无限重试；STT 重连时丢用户语音。

Pipecat 做法：

- ErrorFrame/FatalErrorFrame 带 fatal、processor、exception 上下文，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:839` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/frames/frames.py:863`。
- processor 捕获异常后 upstream 推 error，并带异常文件行号，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:618`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:664`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/frame_processor.py:673`。
- WebSocketService 有 ping、指数退避、并发重连保护、快速失败，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/websocket_service.py:52`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/websocket_service.py:81`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/websocket_service.py:86`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/websocket_service.py:159`。
- STT 重连 VAD-aware：用户说话时推迟重连，期间缓存音频，成功后 replay，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:168`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:356`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:511`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:584`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/stt_service.py:607`。

对 voice-first 的启发：当前 V1 先做明确错误阶段和 retry policy；P2 的流式 STT 再做 VAD-aware reconnect。

### 1.10 Metrics / observability

主流问题：不知道慢在哪里；无法判断 STT/TTS/LLM/播放哪个阶段拖慢；打断后的 stale metrics 污染下一轮。

Pipecat 做法：

- Metrics 覆盖 TTFB、processing、LLM usage、TTS usage、text aggregation、turn probability、e2e，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:29`、`/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:39`、`/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:68`、`/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:78`、`/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:88`、`/Users/lettery/Documents/code/pipecat/src/pipecat/metrics/metrics.py:101`。
- `FrameProcessorMetrics` 封装 TTFB、processing、text aggregation，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:113`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:128`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:151`、`/Users/lettery/Documents/code/pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:218`。
- `UserBotLatencyObserver` 从 VAD stop 到 BotStartedSpeaking 计算延迟，并在 interruption 时清 stale metrics，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/observers/user_bot_latency_observer.py:143`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/user_bot_latency_observer.py:245`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/user_bot_latency_observer.py:257`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/user_bot_latency_observer.py:276`。
- `TurnTrackingObserver` 跟踪 turn start/stop/interruption，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/observers/turn_tracking_observer.py:29`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/turn_tracking_observer.py:91`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/turn_tracking_observer.py:131`、`/Users/lettery/Documents/code/pipecat/src/pipecat/observers/turn_tracking_observer.py:158`。

对 voice-first 的启发：先落地每轮 `turnId` 和阶段耗时，不等实时化。

### 1.11 Provider / transport abstraction

主流问题：STT/TTS/LLM/provider 一换就牵动 runtime；本地和远端音频 IO 不可替换。

Pipecat 做法：

- `AIService` 是 LLM/STT/TTS 基类，统一 lifecycle、settings update、metrics、frame 输出，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/services/ai_service.py:31`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/ai_service.py:109`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/ai_service.py:186`、`/Users/lettery/Documents/code/pipecat/src/pipecat/services/ai_service.py:205`。
- `BaseTransport` 只暴露 input/output 两个 processor，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_transport.py:86` 和 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/base_transport.py:111`。
- WebSocket transport 使用 serializer 解耦网络消息和 frame，见 `/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:255`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:301`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:308`、`/Users/lettery/Documents/code/pipecat/src/pipecat/transports/websocket/fastapi.py:490`。

对 voice-first 的启发：先把当前 concrete class 抽接口，`VoiceCoachApp` 只依赖 `Recorder/STT/TTS/Player/Coach` 接口。

### 1.12 测试方式

主流问题：真实麦克风、真实 STT/TTS、真实 LLM 太慢太贵，无法覆盖竞态和打断。

Pipecat 做法：

- 测试直接构造 VAD/transcription/sleep frame，验证事件顺序，见 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:50` 和 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:58`。
- 覆盖无 transcription 兜底停止、有 transcription 策略提前停止，见 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:74` 和 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:115`。
- 覆盖 external provider 直接发 user started/stopped，见 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:153` 和 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:181`。
- late transcription 回归测试防上一轮污染下一轮，见 `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:203`、`/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:249`、`/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:255`。
- audio buffer 测试模拟用户/机器人交替说话时 silence 对齐，见 `/Users/lettery/Documents/code/pipecat/tests/test_audio_buffer_processor.py:253` 和 `/Users/lettery/Documents/code/pipecat/tests/test_audio_buffer_processor.py:292`。

对 voice-first 的启发：先用 fake frame/event 序列测状态和打断，不依赖真实服务。

## 2. 新的完整 TODO 总览

优先级定义：

- P0：不做会带来安全风险，或阻塞后续可测试、可迭代实现。
- P1：V1 可靠性、可观测性、用户体验基础。
- P2：向实时/低延迟/可打断演进的核心架构。
- P3：更完整的实时语音能力和远端 transport。

建议执行顺序：

1. P0-A：替换通用 bash 为结构化笔记工具。
2. P0-B：抽象 runtime 依赖并建立 fake 全链路测试。
3. P0-C：引入最小事件/frame 协议，不马上重写成完整 pipeline。
4. P1-A：修录音/播放进程生命周期和 cleanup。
5. P1-B：补 preflight、临时文件清理、错误分层。
6. P1-C：补 turnId、阶段耗时、工具审计日志。
7. P1-D：固化笔记结构和英语教练 prompt 行为。
8. P2-A：实现可取消 turn runtime，为 barge-in 做准备。
9. P2-B：实现 VAD/TurnController 的非默认实验模式。
10. P2-C：实现可中断 TTS/player。
11. P3：streaming STT/TTS、chunked transport、完整实时管线。

## 3. P0 TODO

### P0-A：替换通用 bash 为结构化笔记工具

#### 为什么

当前 `src/tools/bashTool.ts:45` 允许模型执行 `bash -lc`，即使有黑名单也不适合作为长期语音 Agent 的工具边界。Pipecat 的做法是把能力封成明确 service/processor，而不是给模型裸 shell。

#### 实现任务

- [ ] 新增 `src/tools/notePathPolicy.ts`。
- [ ] 新增 `resolveNotePath(relativeOrAbsolutePath)`，要求 resolve 后必须在 `config.notesRoot` 内。
- [ ] 限制笔记扩展名为 `.md` / `.markdown`。
- [ ] 禁止目录穿越，如 `../` 指向外部。
- [ ] 新增 `src/tools/notesTools.ts`，实现以下工具：
  - [ ] `search_notes(query, maxResults?)`
  - [ ] `read_note(path, maxChars?)`
  - [ ] `append_note(path, content)`
  - [ ] `create_note(path, content)`
- [ ] 默认不覆盖已有文件；`create_note` 遇到已存在文件失败并建议用 append。
- [ ] 每个工具返回结构化 details：`operation/path/bytes/elapsedMs`。
- [ ] `src/agent/piEnglishCoach.ts:25` 从 `[createBashTool(config)]` 改为结构化 notes tools。
- [ ] `src/prompts/englishCoach.ts` 删除“bash 规则”，改为“笔记工具规则”。
- [ ] 暂时保留 `src/tools/bashTool.ts` 但不注册；或移动到 dev-only 后续再删。

#### 验收标准

- [ ] Agent 无法执行任意 shell 字符串。
- [ ] `../secret.md` 被拒绝。
- [ ] `/tmp/foo.md` 被拒绝。
- [ ] `vocab.txt` 被拒绝。
- [ ] `append_note("vocab.md")` 成功追加。
- [ ] `create_note("sessions/YYYY-MM-DD.md")` 可自动创建父目录。
- [ ] `npm run build` 通过。
- [ ] 有单元测试覆盖路径策略和工具行为。

### P0-B：抽象 runtime 依赖，建立 fake 全链路测试

#### 为什么

当前 `VoiceCoachApp` 在 `src/runtime/voiceCoachApp.ts:28` 直接 new 真实 recorder/STT/TTS/player/coach，导致无法像 Pipecat 的 frame tests 那样构造可控输入验证竞态。

#### 实现任务

- [ ] 新增 `src/runtime/ports.ts`。
- [ ] 定义接口：
  - [ ] `Recorder { start(): Promise<void> | void; stop(): Promise<string>; cleanup?(): Promise<void> | void }`
  - [ ] `SpeechToText { transcribe(audioPath: string, signal?: AbortSignal): Promise<string> }`
  - [ ] `TextToSpeech { synthesize(text: string, signal?: AbortSignal): Promise<string> }`
  - [ ] `AudioOutput { play(filePath: string, signal?: AbortSignal): Promise<void>; stop?(): Promise<void> | void }`
  - [ ] `CoachAgent { runTurn(userText: string, signal?: AbortSignal): Promise<string>; subscribe(handler): void }`
- [ ] `VoiceCoachApp` 构造函数改为接收 ports。
- [ ] 新增 `createProductionApp(config)`，集中创建真实依赖。
- [ ] `src/cli.ts` 只负责 loadConfig + preflight + createProductionApp + run。
- [ ] 使用 Node 内置 test runner 或 Vitest 建立测试；建议 Node 内置 test runner，减少依赖。
- [ ] 新增 fake 全链路测试：fake recorder -> fake STT -> fake coach -> fake TTS -> fake player。

#### 验收标准

- [ ] 不接真实麦克风、不调用 ElevenLabs、不调用模型，也能测完整单轮。
- [ ] 状态序列为 `idle -> recording -> transcribing -> thinking -> speaking -> done -> idle`。
- [ ] STT 失败进入 `error -> idle`。
- [ ] Agent 失败进入 `error -> idle`。
- [ ] TTS 失败时保留终端文本。
- [ ] play 失败时保留终端文本。
- [ ] `npm run build && npm test` 通过。

### P0-C：引入最小事件/frame 协议

#### 为什么

Pipecat 通过 `SystemFrame/DataFrame/ControlFrame/UninterruptibleFrame` 和优先级队列解决 cancel/interrupt/error 插队问题。voice-first 当前还不需要完整 pipeline，但需要先建立事件语义，避免后续实时功能污染 `VoiceCoachApp`。

#### 实现任务

- [ ] 新增 `src/runtime/events.ts`。
- [ ] 定义最小事件类型：
  - [ ] `TurnStarted`
  - [ ] `RecordingStarted`
  - [ ] `RecordingStopped`
  - [ ] `TranscriptReady`
  - [ ] `AgentTextDelta`
  - [ ] `AgentReplyReady`
  - [ ] `ToolStarted`
  - [ ] `ToolFinished`
  - [ ] `SpeechStarted`
  - [ ] `SpeechFinished`
  - [ ] `TurnFinished`
  - [ ] `TurnFailed`
  - [ ] `InterruptionRequested`
- [ ] 定义事件优先级：system/control/data。
- [ ] 先不实现完整 queue processor，只让 `VoiceCoachApp` 发出事件并可被测试订阅。
- [ ] 后续 P2 的 interrupt/cancel 基于这些事件扩展。

#### 验收标准

- [ ] 测试能断言事件序列，而不是只断言 console 输出。
- [ ] 工具调用事件可统计。
- [ ] 错误事件包含 `turnId/stage/message`。
- [ ] 不显著改变当前 CLI 使用方式。

## 4. P1 TODO

### P1-A：录音、播放、退出生命周期

#### 为什么

Pipecat 在 task/processor 层有 cancel timeout 和 cleanup。voice-first 当前 `src/audio/ffmpegRecorder.ts:22` 启动 ffmpeg 后，对启动失败、退出中断、stop 超时、录音中 `q` 没有完整生命周期保障。

#### 实现任务

- [ ] `FfmpegRecorder.start()` 改为 async，等待 ffmpeg 进入可录状态或快速失败。
- [ ] 捕获 spawn error：ffmpeg 不存在、权限失败、设备不存在。
- [ ] `FfmpegRecorder.stop({ timeoutMs })` 增加 SIGINT 后等待超时；超时后 SIGKILL。
- [ ] 新增 `FfmpegRecorder.cleanup()`，录音中退出时杀进程。
- [ ] `AudioPlayer` 保存当前 child process。
- [ ] 新增 `AudioPlayer.stop()`，用于 interrupt/退出时停止播放。
- [ ] `VoiceCoachApp.run()` 使用 `try/finally` 调 cleanup。
- [ ] 捕获 `SIGINT/SIGTERM`，优雅停止 readline、录音、播放。

#### 验收标准

- [ ] 录音中输入 `q` 不留下 ffmpeg 子进程。
- [ ] ffmpeg 不存在给出明确错误和安装建议。
- [ ] 麦克风设备不存在时错误可读。
- [ ] stop 超时能退出并回到 idle 或安全退出。
- [ ] 播放中退出可停止 `afplay`。

### P1-B：临时音频文件清理与 TTS 输出扩展名

#### 实现任务

- [ ] 在 config 增加 `keepTempAudio: boolean`，对应 `KEEP_TEMP_AUDIO`。
- [ ] 录音音频处理完成后删除。
- [ ] TTS 音频播放成功后删除。
- [ ] 失败时默认保留当前轮相关临时文件，并在错误中打印路径；如果 `KEEP_TEMP_AUDIO=false` 且确认无调试价值，可以清理。
- [ ] 根据 `ELEVENLABS_TTS_OUTPUT_FORMAT` 推导扩展名：`mp3_* -> .mp3`、`wav_* -> .wav`、`pcm_* -> .pcm`、未知为 `.bin`。

#### 验收标准

- [ ] 正常流程不会堆积 `voice-first-recording-*` 和 `voice-first-*` 音频文件。
- [ ] `KEEP_TEMP_AUDIO=true` 保留文件。
- [ ] TTS 输出路径扩展名和 output format 匹配。

### P1-C：Preflight 检查

#### 实现任务

- [ ] 新增 `src/runtime/preflight.ts`。
- [ ] 检查 Node 版本。
- [ ] 检查 `ffmpeg` 可执行。
- [ ] 检查 `AUDIO_PLAYER` 可执行。
- [ ] 检查 `NOTES_ROOT` 存在、是目录、可读写。
- [ ] 检查 `PROJECT_ROOT` 存在、是目录。
- [ ] 检查必填 API key 非空且不是 example placeholder。
- [ ] preflight 不调用模型，不调用 ElevenLabs 付费接口。
- [ ] 修正 `env.example` 中 `PROJECT_ROOT` 示例路径，避免和当前仓库不一致。

#### 验收标准

- [ ] 缺 ffmpeg 时启动失败信息包含修复建议。
- [ ] notesRoot 不可写时启动失败信息明确。
- [ ] placeholder API key 被识别为未配置。
- [ ] `npm run build` 通过。

### P1-D：可观测性、turnId、工具审计日志

#### 为什么

Pipecat 对 STT TTFB、TTS TTFB、user-to-bot latency、turn tracking 都有指标。voice-first 应先实现轻量版本。

#### 实现任务

- [ ] 新增 `src/runtime/metrics.ts`。
- [ ] 每轮生成 `turnId`。
- [ ] 记录阶段耗时：`recordingDurationMs/sttMs/agentMs/ttsMs/playMs/totalMs`。
- [ ] 记录 `transcriptChars/replyChars/toolCallCount`。
- [ ] Agent tool start/end 增加 elapsedMs。
- [ ] 错误包含 `turnId/stage/errorType/message`。
- [ ] 新增 `.logs/` 可选本地日志目录，加入 `.gitignore`。
- [ ] 不记录 API key。

#### 验收标准

- [ ] CLI 每轮结束打印简短 metrics summary。
- [ ] 工具是否调用一眼可见。
- [ ] 日志不泄漏密钥。
- [ ] 测试覆盖 metrics 在失败时也完整收口。

### P1-E：固定笔记结构和 Prompt 行为

#### 实现任务

- [ ] 固定默认笔记结构：
  - [ ] `vocab.md`
  - [ ] `corrections.md`
  - [ ] `sessions/YYYY-MM-DD.md`
- [ ] `append_note` 支持自动创建 `sessions/`。
- [ ] Prompt 明确：词汇默认写 `vocab.md`，纠错默认写 `corrections.md`，总结默认写当天 session。
- [ ] 写入模板包括：时间、原始表达、更自然表达、简短解释、例句、标签。
- [ ] 最终口播只总结“已写入哪里”，不朗读完整 Markdown。

#### 验收标准

- [ ] “把这个单词记下来”默认写 `vocab.md`。
- [ ] “把刚才纠正记下来”默认写 `corrections.md`。
- [ ] “总结今天练习”默认写 `sessions/YYYY-MM-DD.md`。
- [ ] 读笔记时回复说明依据文件名。

## 5. P2 TODO：从批处理 V1 走向可打断语音交互

### P2-A：可取消 TurnRuntime

#### 为什么

Pipecat 的 interruption 会一路取消 LLM/TTS/transport。voice-first 需要先有可取消 turn，才能做 barge-in。

#### 实现任务

- [ ] 新增 `src/runtime/turnRuntime.ts`。
- [ ] 每轮创建 `AbortController`。
- [ ] STT、Agent、TTS、Player ports 支持 `AbortSignal`。
- [ ] `VoiceCoachApp` 增加 `interruptCurrentTurn(reason)`。
- [ ] Agent 如果正在 streaming delta，interrupt 后停止继续打印旧 delta。
- [ ] TTS 正在生成时 interrupt 后忽略旧结果。
- [ ] Player 正在播放时 interrupt 后 stop。
- [ ] 事件发出 `InterruptionRequested` 和 `TurnInterrupted`。

#### 验收标准

- [ ] fake 测试中，播放期间触发 interrupt，player.stop 被调用。
- [ ] TTS 慢返回时，其旧结果不会播放。
- [ ] Agent 慢返回时，其旧回复不会进入下一轮。
- [ ] interrupt 后可以开始新一轮。

### P2-B：VAD/TurnController 实验模式

#### 实现任务

- [ ] 保留默认手动 `r/s` 模式。
- [ ] 新增实验配置 `VOICE_TURN_MODE=manual|vad`，默认 `manual`。
- [ ] 新增 VAD params：`VAD_CONFIDENCE`、`VAD_START_SECS`、`VAD_STOP_SECS`、`VAD_MIN_VOLUME`、`VAD_AUDIO_IDLE_TIMEOUT_MS`。
- [ ] 实现 `TurnController`，输入事件包括 manual stop、vad start、vad stop、transcript final、timeout。
- [ ] 先使用能在 Node/macOS 本地运行的 VAD 方案；如果引入外部库，必须单独评估安装和性能。
- [ ] 先做 offline segmented STT：VAD stop 后提交整段音频，不立刻做 streaming STT。

#### 验收标准

- [ ] manual 模式行为不变。
- [ ] vad 模式下短噪声不触发 start。
- [ ] 用户短暂停顿不立即 stop。
- [ ] audio idle timeout 能强制结束卡住的 speaking。
- [ ] 单元测试覆盖 QUIET/STARTING/SPEAKING/STOPPING 状态。

### P2-C：可中断 TTS/Player 和 speak context

#### 实现任务

- [ ] 给每次 TTS 生成分配 `speakContextId`。
- [ ] 播放前确认 context 仍是当前 active context。
- [ ] `AudioPlayer.stop()` 能停止当前播放。
- [ ] TTS 完成后如 context 已被 interrupt，立即清理文件，不播放。
- [ ] 可选：替换 `afplay` 为可 chunk 控制的播放器，为 P3 打基础。

#### 验收标准

- [ ] interrupt 后旧 TTS 文件不会播放。
- [ ] 快速连续两轮不会交叉播放。
- [ ] 播放失败不影响文本输出。

### P2-D：最小 frame/event 测试体系

#### 实现任务

- [ ] 类似 Pipecat tests，直接构造事件序列测试 turn 行为。
- [ ] 测试 user started -> interruption -> bot stopped。
- [ ] 测试 late transcript 不污染下一轮。
- [ ] 测试 End/cleanup 不会被 interruption 丢弃。
- [ ] 测试 TTS stale context 不播放。

#### 参考代码

- `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:50`
- `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_processor.py:74`
- `/Users/lettery/Documents/code/pipecat/tests/test_user_turn_controller.py:203`
- `/Users/lettery/Documents/code/pipecat/tests/test_audio_buffer_processor.py:253`

## 6. P3 TODO：完整实时语音能力

P3 不建议现在实现，只保留方向。

### P3-A：Streaming STT

- [ ] 引入连续音频 source，按 20ms/40ms frame 产生 PCM。
- [ ] 实现 `StreamingSTT` port。
- [ ] 支持 partial transcript 和 final transcript。
- [ ] bot speaking 时发送 STT mute，避免自转写。
- [ ] 实现 STT keepalive。
- [ ] 实现 VAD-aware reconnect：用户说话时延迟重连，期间缓存音频，成功后 replay。

### P3-B：Streaming LLM -> Streaming TTS

- [ ] Agent text delta 分句聚合。
- [ ] 支持 `TTS_AGGREGATION_MODE=sentence|token`。
- [ ] 按句更自然；按 token 更低延迟。
- [ ] 记录 text aggregation latency。
- [ ] 每个 TTS context 内 FIFO 输出 audio/text/stopped。

### P3-C：Chunked audio transport

- [ ] 替换整段 `afplay`，实现 20-40ms chunk player。
- [ ] 输出音频按 `10ms * chunks` 切片。
- [ ] 模拟真实播放节拍，不一次性写完整段。
- [ ] interruption 时清理 output queue，最多泄漏一个短 chunk。

### P3-D：完整 pipeline processor

- [ ] 如 P2 的事件协议不够，升级为 mini pipeline：source -> processors -> sink。
- [ ] 实现 system/data/control priority queue。
- [ ] 支持 downstream/upstream。
- [ ] 支持 Uninterruptible cleanup frame。

## 7. 建议审查决策

开始实现前，请确认：

- [ ] 是否同意 P0-A：用结构化笔记工具替换通用 bash。
- [ ] 是否保留 `bashTool.ts` 作为 dev-only 未注册工具，还是直接删除。
- [ ] 测试框架选择 Node 内置 test runner 还是 Vitest。
- [ ] 是否接受 `VoiceCoachApp` 依赖注入改造。
- [ ] 是否固定笔记结构为 `vocab.md`、`corrections.md`、`sessions/YYYY-MM-DD.md`。
- [ ] 是否启用 `.logs/` 本地日志目录。
- [ ] 是否加入 `KEEP_TEMP_AUDIO`。
- [ ] P2 的 VAD 是否先作为实验模式，不改变默认 manual 模式。

## 8. 第一轮实现切片建议

如果只做第一轮，建议只做这些：

1. 结构化笔记工具替换 bash。
2. runtime ports + fake 全链路测试。
3. turnId + metrics + 工具审计日志。
4. recorder/player cleanup。
5. preflight。

第一轮不做：

- VAD。
- streaming STT。
- streaming TTS。
- chunked audio player。
- 完整 pipeline。

这样能先把当前 V1 变成安全、可测、可恢复的基础版本，同时为 Pipecat 风格的实时语音架构留下正确接口。

## 9. Rust 原生桌面窗口方案（新增）

- 日期：2026-05-03
- 状态：已确认方向，等待实现/验证
- 用户约束：不要 Web，不使用 Tauri/WebView/Electron；优先 Rust 轻量原生桌面。
- 范围约束：先不做 VAD；用显式交互按钮代替自动语音检测。

### 9.1 产品交互目标

桌面程序提供一个轻量对话窗口：

- 中间是对话消息列表。
- 底部是文本输入框。
- 输入框右侧有一个圆形按钮。
- 文本输入框支持直接输入文字并发送。
- 圆形按钮同时承担语音输入控制和打断控制。

圆形按钮状态机：

- `idle`：点击开始语音输入。
- `recording`：点击停止录音，并把录音转写后发送给模型。
- `thinking`：点击打断当前模型生成。
- `speaking`：点击打断当前语音播放。
- `error`：点击回到 idle 或重置当前 turn。

### 9.2 技术架构

推荐两层架构：

```text
Rust Desktop App
- eframe/egui 原生窗口
- 对话消息列表
- 文本输入框
- 圆形状态按钮
- 发送 JSON Lines 命令给 TS engine

TypeScript Voice Engine
- 复用 PiEnglishCoach
- 复用 ElevenLabs STT/TTS
- 复用 FfmpegRecorder / AudioPlayer
- 复用安全 notes tools
- 暴露 stdin/stdout JSON-RPC / JSON Lines 协议
```

第一版不把整个后端重写成 Rust，原因：当前 Pi Agent Core、模型适配、ElevenLabs SDK、安全笔记工具已经在 TS 内稳定工作。先用 Rust 做轻 UI，TS 做 voice engine；后续再逐步迁移 provider/runtime 到 Rust。

### 9.3 TS Voice Engine TODO

新增入口：`src/desktop/engine.ts`。

命令协议：

- `send_text`：输入文本，直接发送给 Agent。
- `start_recording`：开始 ffmpeg 录音。
- `stop_recording`：停止录音，执行 STT -> Agent -> TTS -> 播放。
- `interrupt`：打断当前 Agent/TTS/播放，并回到 idle。
- `shutdown`：清理 recorder/player，退出进程。

事件协议：

- `ready`
- `state`
- `user_text`
- `assistant_text`
- `assistant_delta`
- `tool_start`
- `tool_end`
- `error`
- `done`

验收标准：

- [ ] `npm run build` 生成 `dist/desktop/engine.js`。
- [ ] 可以通过 stdin 写入一行 JSON 命令。
- [ ] 每个响应事件都是单行 JSON，便于 Rust 端读取。
- [ ] `interrupt` 能停止当前播放或让旧结果失效。
- [ ] 不恢复通用 `bash`。
- [ ] 单元测试使用 fake ports，不调用真实 Provider。

### 9.4 Rust Desktop TODO

新增目录：`desktop/`。

实现要求：

- [ ] 使用 Rust + `eframe/egui`。
- [ ] 不使用 Tauri/WebView/Electron。
- [ ] 有消息列表。
- [ ] 有底部文本输入框。
- [ ] 输入框右侧有圆形按钮。
- [ ] Enter 发送文本。
- [ ] 圆形按钮按状态发出 `start_recording` / `stop_recording` / `interrupt`。
- [ ] 第一版可先使用 mock engine client，后续替换为 JSON Lines 子进程 client。
- [ ] `cargo build` 通过。

### 9.5 第一轮实现切片

先做：

1. Rust UI mock 原型：证明原生窗口、消息列表、输入框、圆形按钮可运行。
2. TS engine JSON Lines 协议：证明后端可以被桌面程序驱动。
3. 两边保持解耦：Rust 先 mock，TS engine 先可用 stdin/stdout 手测。

暂不做：

- VAD。
- 自动检测用户开口。
- Streaming STT/TTS。
- 完整 Rust 后端迁移。
- 多窗口或系统托盘。

### 9.6 真实测试接入状态（2026-05-05 更新）

用户最新决策：

- Agent 恢复通用 `bash` 工具。
- `NOTES_ROOT` / `PROJECT_ROOT` 只作为参考路径和环境变量提供，不作为访问路径限制。
- 暂时不做 VAD，继续用桌面按钮显式控制开始录音、停止录音和打断。
- Rust 桌面 UI 需要接入真实 TS voice engine，而不是停留在 mock。

已执行/待验收：

- [x] `PiEnglishCoach` 恢复注册 `bash` 工具。
- [x] Prompt 改为“路径参考”，不再描述路径限制。
- [x] TS desktop engine 支持 JSON Lines 命令和事件。
- [x] TS desktop engine 命令读取改为可并发处理，使 `interrupt` 能在长 turn 中被读取。
- [x] Rust 桌面 app 从 mock engine client 改为启动 `npm run --silent desktop:engine` 子进程。
- [x] Rust 桌面 app 通过 stdin/stdout JSON Lines 与 TS engine 通信。
- [x] Rust 桌面 app 根据 engine event 更新消息和按钮状态。
- [x] `npm run build`、`npm test`、`npm run desktop:build` 通过。

真实测试入口：

```bash
npm run desktop:run
```

测试前确认：

- `.env` 中 `CRS_OAI_KEY`、`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID` 已配置。
- `NOTES_ROOT` 存在且可读写。
- `ffmpeg` 和 `AUDIO_PLAYER` 可执行。
- macOS 已授权终端/程序麦克风权限。
