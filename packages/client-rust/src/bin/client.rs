use open_xiaoai::services::audio::config::AudioConfig;
use open_xiaoai::services::monitor::kws::KwsMonitor;
use serde_json::json;
use std::time::Duration;
use tokio::time::sleep;
use tokio_tungstenite::connect_async;

use open_xiaoai::base::AppError;
use open_xiaoai::base::VERSION;
use open_xiaoai::services::audio::play::AudioPlayer;
use open_xiaoai::services::audio::record::AudioRecorder;
use open_xiaoai::services::connect::data::{Event, Request, Response, Stream};
use open_xiaoai::services::connect::handler::MessageHandler;
use open_xiaoai::services::connect::message::{MessageManager, WsStream};
use open_xiaoai::services::connect::rpc::RPC;
use open_xiaoai::services::monitor::file::FileMonitorEvent;
use open_xiaoai::services::monitor::instruction::InstructionMonitor;
use open_xiaoai::services::monitor::kws::KwsMonitorEvent;
use open_xiaoai::services::monitor::playing::PlayingMonitor;
use open_xiaoai::utils::shell::run_shell as run_local_shell;
use serde_json::Value;

struct AppClient {
    kws_monitor: KwsMonitor,
    instruction_monitor: InstructionMonitor,
    playing_monitor: PlayingMonitor,
}

impl AppClient {
    pub fn new() -> Self {
        Self {
            kws_monitor: KwsMonitor::new(),
            instruction_monitor: InstructionMonitor::new(),
            playing_monitor: PlayingMonitor::new(),
        }
    }

    pub async fn connect(&self, url: &str) -> Result<WsStream, AppError> {
        let (ws_stream, _) = connect_async(url).await?;
        Ok(WsStream::Client(ws_stream))
    }

    pub async fn run(&mut self) {
        let url = std::env::args()
            .nth(1)
            .expect("❌ 请输入服务器地址（例如 ws://192.168.1.10:4399 或 wss://mi.example.com）");
        println!("✅ 已启动");
        loop {
            let ws_stream = match self.connect(&url).await {
                Ok(stream) => stream,
                Err(error) => {
                    // 连接失败时保留重试行为，同时输出具体错误，便于区分
                    // DNS、端口、证书以及 URL 协议配置问题。
                    eprintln!("❌ 连接服务端失败（{}）：{}", url, error);
                    sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            println!("✅ 已连接: {:?}", url);
            self.init(ws_stream).await;
            if let Err(e) = MessageManager::instance().process_messages().await {
                eprintln!("❌ 消息处理异常: {}", e);
            }
            self.dispose().await;
            eprintln!("❌ 已断开连接");
        }
    }

    async fn init(&mut self, ws_stream: WsStream) {
        MessageManager::instance().init(ws_stream).await;
        MessageHandler::<Event>::instance()
            .set_handler(on_event)
            .await;
        MessageHandler::<Stream>::instance()
            .set_handler(on_stream)
            .await;

        let rpc = RPC::instance();
        rpc.add_command("get_version", get_version).await;
        rpc.add_command("run_shell", run_shell).await;
        rpc.add_command("start_play", start_play).await;
        rpc.add_command("stop_play", stop_play).await;
        rpc.add_command("start_recording", start_recording).await;
        rpc.add_command("stop_recording", stop_recording).await;

        self.instruction_monitor
            .start(|event| async move {
                // MiGPT 的 Node 端需要等待 WebSocket 事件才能暂停播放器，但
                // WebSocket/Node 在高负载时可能晚几百毫秒。先在音箱本地切断
                // 输出，再把 ASR 事件转发给 Node，保证唤醒时不会继续播报。
                // 播客使用 mediaplayer 音乐队列，本地只清理 miplayer/TTS
                // 进程并暂停队列；这样“只唤醒不说话”仍可由 Node 恢复播客，
                // 而 AI、原生小爱和普通 URL 音频不会在后台续播。
                if let FileMonitorEvent::NewLine(line) = &event {
                    if is_vad_begin(line) {
                        let _ = interrupt_local_output().await;
                    }
                    if is_stop_text(line) {
                        let _ = stop_local_output().await;
                    }
                }
                MessageManager::instance()
                    .send_event("instruction", Some(json!(event)))
                    .await
            })
            .await;

        self.playing_monitor
            .start(|event| async move {
                MessageManager::instance()
                    .send_event("playing", Some(json!(event)))
                    .await
            })
            .await;

        self.kws_monitor
            .start(|event| async move {
                // KWS 日志在部分固件上比 instruction.log 更早出现；把它
                // 作为同样的本地抢麦兜底，避免等待最终 ASR 才静音。
                if matches!(event, KwsMonitorEvent::Keyword(_)) {
                    let _ = interrupt_local_output().await;
                }
                MessageManager::instance()
                    .send_event("kws", Some(json!(event)))
                    .await
            })
            .await;
    }

    async fn dispose(&mut self) {
        MessageManager::instance().dispose().await;
        let _ = AudioPlayer::instance().stop().await;
        let _ = AudioRecorder::instance().stop_recording().await;
        self.instruction_monitor.stop().await;
        self.playing_monitor.stop().await;
        self.kws_monitor.stop().await;
        // MiGPT 断开时只清理由它创建的实验模式文件，自动恢复原生小爱。
        let _ = run_local_shell(
            r#"
                if [ -f /data/pns.lab ] && grep -qxF '# managed by open-xiaoai MiGPT' /data/pns.lab; then
                    rm -f /data/pns.lab
                    /etc/init.d/mico_aivs_lab restart >/dev/null 2>&1
                fi
            "#,
        )
        .await;
    }
}

/// 只暂停当前输出，并立即结束当前 miplayer 输出。
///
/// OH2P 的 `mphelper mute_stat` 对 miplayer TTS 通常返回 idle，单纯调用
/// pause 只会压低音量。MiGPT 的播客使用 mediaplayer 的音乐队列，因而
/// 这里结束 miplayer 不会破坏播客断点；如果是原生小爱或 MiGPT 的普通
/// 音频，则必须先杀掉 miplayer，才能保证唤醒后不会继续抢麦。播客仍由
/// Node 端在无新指令时恢复。
async fn interrupt_local_output() -> Result<(), AppError> {
    run_local_shell(
        "killall tts_play.sh 2>/dev/null; \
         killall miplayer 2>/dev/null; \
         killall -9 tts_play.sh 2>/dev/null; \
         killall -9 miplayer 2>/dev/null; \
         if [ \"$(mphelper mute_stat 2>/dev/null)\" = \"1\" ]; then \
             mphelper pause >/dev/null 2>&1; \
         fi",
    )
    .await
    .map(|_| ())
}

/// “停止”是最高优先级控制词。即使 Node 端正在重启/忙于保存进度，
/// 也要在音箱本地立即清掉播放器，避免用户听到旧回复。
async fn stop_local_output() -> Result<(), AppError> {
    run_local_shell(
        "killall tts_play.sh 2>/dev/null; \
         killall miplayer 2>/dev/null; \
         killall -9 tts_play.sh 2>/dev/null; \
         killall -9 miplayer 2>/dev/null; \
         mphelper pause >/dev/null 2>&1; \
         /etc/init.d/mediaplayer restart >/dev/null 2>&1",
    )
    .await
    .map(|_| ())
}

fn is_vad_begin(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("payload").cloned())
        .and_then(|payload| payload.get("is_vad_begin").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn is_stop_text(line: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let Some(text) = value
        .get("payload")
        .and_then(|payload| payload.get("results"))
        .and_then(|results| results.get(0))
        .and_then(|result| result.get("text"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let is_final = value
        .get("payload")
        .and_then(|payload| payload.get("is_final"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    is_final
        && ["停止", "停下来", "结束播放", "停止播放", "别播了", "闭嘴"]
            .iter()
            .any(|keyword| text.contains(keyword))
}

async fn get_version(_: Request) -> Result<Response, AppError> {
    let data = json!(VERSION.to_string());
    Ok(Response::from_data(data))
}

async fn start_play(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    AudioPlayer::instance().start(config).await?;
    Ok(Response::success())
}

async fn stop_play(_: Request) -> Result<Response, AppError> {
    AudioPlayer::instance().stop().await?;
    Ok(Response::success())
}

async fn start_recording(request: Request) -> Result<Response, AppError> {
    let config = request
        .payload
        .and_then(|payload| serde_json::from_value::<AudioConfig>(payload).ok());
    AudioRecorder::instance()
        .start_recording(
            |bytes| async {
                MessageManager::instance()
                    .send_stream("record", bytes, None)
                    .await
            },
            config,
        )
        .await?;
    Ok(Response::success())
}

async fn stop_recording(_: Request) -> Result<Response, AppError> {
    AudioRecorder::instance().stop_recording().await?;
    Ok(Response::success())
}

async fn run_shell(request: Request) -> Result<Response, AppError> {
    let script = match request.payload {
        Some(payload) => serde_json::from_value::<String>(payload)?,
        _ => return Err("empty command".into()),
    };
    let res = open_xiaoai::utils::shell::run_shell(script.as_str()).await?;
    Ok(Response::from_data(json!(res)))
}

async fn on_event(event: Event) -> Result<(), AppError> {
    println!("🔥 收到事件: {:?}", event);
    Ok(())
}

async fn on_stream(stream: Stream) -> Result<(), AppError> {
    let Stream { tag, bytes, .. } = stream;
    if tag.as_str() == "play" {
        // 播放接收到的音频流
        let _ = AudioPlayer::instance().play(bytes).await;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    // rustls 0.23 不再自动选择加密实现。显式安装 ring Provider，
    // 否则首次连接 wss:// 时会在音箱上 panic 并被启动脚本反复重启。
    let _ = rustls::crypto::ring::default_provider().install_default();
    AppClient::new().run().await;
}
