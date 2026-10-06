use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore};
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

use super::rpc::RPC;
use crate::base::AppError;
use crate::utils::task::TaskManager;

use super::data::{AppMessage, Event, Request, Response, Stream};
use super::handler::MessageHandler;

pub enum WsStream {
    Server(WebSocketStream<TcpStream>),
    Client(WebSocketStream<MaybeTlsStream<TcpStream>>),
}

pub enum WsReader {
    Server(SplitStream<WebSocketStream<TcpStream>>),
    Client(SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>),
}

pub enum WsWriter {
    Server(SplitSink<WebSocketStream<TcpStream>, Message>),
    Client(SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>),
}

/// 客户端心跳间隔：定期调用服务端的 get_version RPC，确认 MiGPT 本身仍在线。
///
/// 不能只用 WebSocket Ping：音箱经 Lucky 反向代理和 EasyTier 连到 MiGPT 时，
/// MiGPT 重启后中间链路仍会回 Pong（实测约 170 秒后才断开），客户端误以为连接正常。
/// RPC 必须由 MiGPT 应用层处理并回复，中间链路无法代答。
const CLIENT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// 单次心跳等待服务端回复的超时（毫秒）。
const CLIENT_HEARTBEAT_TIMEOUT_MS: u64 = 10_000;

/// 连续多少次心跳无回复判定连接失效，避免一次偶发延迟就触发重连。
const CLIENT_HEARTBEAT_MAX_FAILURES: u32 = 2;

pub struct MessageManager {
    semaphore: Arc<Semaphore>,
    reader: Arc<Mutex<Option<WsReader>>>,
    writer: Arc<Mutex<Option<WsWriter>>>,
}

static INSTANCE: LazyLock<MessageManager> = LazyLock::new(MessageManager::new);

impl MessageManager {
    fn new() -> Self {
        Self {
            reader: Arc::new(Mutex::new(None)),
            writer: Arc::new(Mutex::new(None)),
            semaphore: Arc::new(Semaphore::new(32)),
        }
    }

    pub fn instance() -> &'static Self {
        &INSTANCE
    }

    pub async fn init(&self, ws_stream: WsStream) {
        match ws_stream {
            WsStream::Client(stream) => {
                let (tx, rx) = stream.split();
                self.reader.lock().await.replace(WsReader::Client(rx));
                self.writer.lock().await.replace(WsWriter::Client(tx));
            }
            WsStream::Server(stream) => {
                let (tx, rx) = stream.split();
                self.reader.lock().await.replace(WsReader::Server(rx));
                self.writer.lock().await.replace(WsWriter::Server(tx));
            }
        }
        RPC::instance()
            .init(|request| async {
                let data = serde_json::to_string(&AppMessage::Request(request)).unwrap();
                MessageManager::instance()
                    .send(Message::Text(data.into()))
                    .await
            })
            .await;
    }

    pub async fn dispose(&self) {
        *self.reader.lock().await = None;
        *self.writer.lock().await = None;
        RPC::instance().dispose().await;
        TaskManager::instance().dispose("MessageManager").await;
    }

    pub async fn send(&self, msg: Message) -> Result<(), AppError> {
        let mut writer_guard = self.writer.lock().await;

        let Some(writer) = &mut *writer_guard else {
            return Err("WebSocket writer is not initialized".into());
        };

        match writer {
            WsWriter::Client(w) => w.send(msg).await?,
            WsWriter::Server(w) => w.send(msg).await?,
        }

        Ok(())
    }

    pub async fn send_event(&self, event: &str, data: Option<Value>) -> Result<(), AppError> {
        let event: Event = Event::new(event, data);
        let data = serde_json::to_string(&AppMessage::Event(event)).unwrap();
        MessageManager::instance()
            .send(Message::Text(data.into()))
            .await
    }

    pub async fn send_stream(
        &self,
        tag: &str,
        bytes: Vec<u8>,
        data: Option<Value>,
    ) -> Result<(), AppError> {
        let stream = serde_json::to_vec(&Stream::new(tag, bytes, data)).unwrap();
        MessageManager::instance()
            .send(Message::Binary(stream.into()))
            .await
    }

    pub async fn process_messages(&self) -> Result<(), AppError> {
        if self.reader.lock().await.is_none() {
            return Err("WebSocket reader is not initialized".into());
        }

        // 只有作为客户端（音箱端）时才做心跳检测；服务端保持原有行为。
        let is_client = matches!(&*self.reader.lock().await, Some(WsReader::Client(_)));
        if !is_client {
            return self.read_loop().await;
        }
        tokio::select! {
            result = self.read_loop() => result,
            _ = Self::wait_heartbeat_lost() => Err(format!(
                "连续 {} 次心跳（get_version）无回复，MiGPT 可能已重启或连接已失效，准备重连",
                CLIENT_HEARTBEAT_MAX_FAILURES
            )
            .into()),
        }
    }

    /// 定期调用服务端 RPC；连续失败达到阈值时返回，由调用方断开并重连。
    async fn wait_heartbeat_lost() {
        let mut failures = 0;
        let mut interval = tokio::time::interval(CLIENT_HEARTBEAT_INTERVAL);
        interval.tick().await;
        loop {
            interval.tick().await;
            match RPC::instance()
                .call_remote("get_version", None, Some(CLIENT_HEARTBEAT_TIMEOUT_MS))
                .await
            {
                Ok(_) => failures = 0,
                Err(error) => {
                    failures += 1;
                    eprintln!(
                        "⚠️ 心跳无回复（第 {}/{} 次）：{}",
                        failures, CLIENT_HEARTBEAT_MAX_FAILURES, error
                    );
                    if failures >= CLIENT_HEARTBEAT_MAX_FAILURES {
                        return;
                    }
                }
            }
        }
    }

    async fn read_loop(&self) -> Result<(), AppError> {
        loop {
            let next_msg = {
                let mut reader = self.reader.lock().await;
                match reader.as_mut() {
                    None => None,
                    Some(WsReader::Client(reader)) => reader.next().await,
                    Some(WsReader::Server(reader)) => reader.next().await,
                }
            };
            match next_msg {
                None => break,
                Some(Ok(Message::Close(_))) => break,
                Some(Err(e)) => return Err(e.into()),
                Some(Ok(msg)) => {
                    match msg {
                        Message::Text(text) => {
                            let _ = self.on_text(text.to_string()).await;
                        }
                        Message::Binary(bytes) => {
                            let _ = self.on_bytes(bytes.into()).await;
                        }
                        _ => {}
                    };
                }
            }
        }

        Ok(())
    }

    async fn on_bytes(&self, bytes: Vec<u8>) -> Result<(), AppError> {
        let data = serde_json::from_slice::<Stream>(&bytes)?;
        MessageHandler::<Stream>::instance().on(data).await
    }

    async fn on_text(&self, text: String) -> Result<(), AppError> {
        let msg = serde_json::from_str::<AppMessage>(&text)?;

        match msg {
            AppMessage::Request(request) => {
                self.run_concurrently(move || {
                    let request = request.clone();
                    async move {
                        MessageHandler::<Request>::instance()
                            .on_request(request)
                            .await?;
                        Ok(())
                    }
                })
                .await
            }
            AppMessage::Response(response) => {
                MessageHandler::<Response>::instance()
                    .on_response(response)
                    .await
            }
            AppMessage::Event(event) => {
                // VAD 抢麦会执行远程 RPC，不能阻塞 WebSocket 读循环，否则随后
                // 到达的 FINAL ASR 无法及时读取，第二条指令就会被吞掉。
                self.run_concurrently(move || {
                    let event = event.clone();
                    async move { MessageHandler::<Event>::instance().on(event).await }
                })
                .await
            }
            _ => Ok(()),
        }
    }

    async fn run_concurrently<F, Fut>(&self, run: F) -> Result<(), AppError>
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        let permit = match self.semaphore.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => self.semaphore.clone().acquire_owned().await?,
        };

        let task = tokio::spawn(async move {
            let _ = run().await;
            drop(permit);
        });

        TaskManager::instance().add("MessageManager", task).await;
        Ok(())
    }
}
