use neon::prelude::Context;
use neon::types::JsUint8Array;
use open_xiaoai::base::{AppError, VERSION};
use open_xiaoai::services::connect::data::{Event, Request, Response, Stream};
use open_xiaoai::services::connect::handler::MessageHandler;
use open_xiaoai::services::connect::message::{MessageManager, WsStream};
use open_xiaoai::services::connect::rpc::RPC;
use open_xiaoai::utils::task::TaskManager;

use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::accept_async;

use crate::node::NodeManager;

pub struct AppServer;

async fn test(address: String) -> Result<(), AppError> {
    NodeManager::instance()
        .call_fn::<(), _, _>(
            "on_event",
            move |cx| {
                cx.string(
                    &serde_json::json!({
                        "event": "connected",
                        "data": { "address": address },
                    })
                    .to_string(),
                )
                .upcast()
            },
            |_, _| Ok(()),
        )
        .await?;
    // let _ = RPC::instance()
    //     .call_remote("start_recording", None, None)
    //     .await;

    // let _ = RPC::instance().call_remote("start_play", None, None).await;

    Ok(())
}

impl AppServer {
    pub async fn connect(stream: TcpStream) -> Result<WsStream, AppError> {
        let ws_stream = accept_async(stream).await?;
        Ok(WsStream::Server(ws_stream))
    }

    pub async fn run() {
        let port = std::env::var("MIGPT_WS_PORT").unwrap_or_else(|_| "4399".to_string());
        let addr = format!("0.0.0.0:{}", port);
        let listener = match TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(error) => {
                // 管理 API 仍可启动，便于在已有 Rust 客户端占用端口时排查配置。
                println!("❌ 绑定地址失败: {}: {}", addr, error);
                return;
            }
        };
        println!("✅ 已启动: {:?}", addr);
        while let Ok((stream, addr)) = listener.accept().await {
            // 同一时刻只处理一个连接
            AppServer::handle_connection(stream, addr).await;
        }
    }

    async fn handle_connection(stream: TcpStream, addr: std::net::SocketAddr) {
        let Ok(ws_stream) = AppServer::connect(stream).await else {
            println!("❌ 连接异常: {}", addr);
            return;
        };
        println!("✅ 已连接: {:?}", addr);
        AppServer::init(ws_stream, addr.to_string()).await;
        if let Err(e) = MessageManager::instance().process_messages().await {
            println!("❌ 消息处理异常: {}", e);
        }
        AppServer::dispose(addr.to_string()).await;
        println!("❌ 已断开连接");
    }

    async fn init(ws_stream: WsStream, address: String) {
        MessageManager::instance().init(ws_stream).await;
        MessageHandler::<Event>::instance()
            .set_handler(on_event)
            .await;
        MessageHandler::<Stream>::instance()
            .set_handler(on_stream)
            .await;

        let rpc = RPC::instance();
        rpc.add_command("get_version", get_version).await;

        let test = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let _ = test(address).await;
        });
        TaskManager::instance().add("test", test).await;
    }

    async fn dispose(address: String) {
        MessageManager::instance().dispose().await;
        TaskManager::instance().dispose("test").await;
        let _ = NodeManager::instance()
            .call_fn::<(), _, _>(
                "on_event",
                move |cx| {
                    cx.string(
                        &serde_json::json!({
                            "event": "disconnected",
                            "data": { "address": address },
                        })
                        .to_string(),
                    )
                    .upcast()
                },
                |_, _| Ok(()),
            )
            .await;
    }
}

async fn get_version(_: Request) -> Result<Response, AppError> {
    let data = json!(VERSION.to_string());
    Ok(Response::from_data(data))
}

async fn on_stream(stream: Stream) -> Result<(), AppError> {
    let Stream { tag, bytes, .. } = stream;
    match tag.as_str() {
        "record" => {
            NodeManager::instance()
                .call_fn::<(), _, _>(
                    "on_input_data",
                    move |cx| JsUint8Array::from_slice(cx, &bytes).unwrap().upcast(),
                    |_, _| Ok(()),
                )
                .await?;
        }
        _ => {}
    }
    Ok(())
}

async fn on_event(event: Event) -> Result<(), AppError> {
    let event_json = serde_json::to_string(&event)?;
    NodeManager::instance()
        .call_fn::<(), _, _>(
            "on_event",
            move |cx| cx.string(&event_json).upcast(),
            |_, _| Ok(()),
        )
        .await?;
    Ok(())
}
