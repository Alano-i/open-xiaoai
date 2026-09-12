// RPC/monitor 任务会跨 tokio::spawn 传递错误，错误对象必须满足 Send + Sync。
// 使用不带这两个约束的 Box<dyn Error> 会让新版 Rust 在构建 MiGPT
// Neon addon 时拒绝编译（并表现为管理命令偶发超时）。
pub type AppError = Box<dyn std::error::Error + Send + Sync>;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
