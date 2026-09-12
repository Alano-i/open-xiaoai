use serde::{Deserialize, Serialize};
use std::future::Future;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncBufReadExt, AsyncSeekExt, BufReader, SeekFrom};
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};

use crate::base::AppError;

#[derive(Debug, Serialize, Deserialize)]
pub enum FileMonitorEvent {
    NewFile,
    NewLine(String),
}

pub struct FileMonitor {
    task_holder: Option<JoinHandle<()>>,
}

impl Default for FileMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl FileMonitor {
    pub fn new() -> Self {
        Self { task_holder: None }
    }

    pub async fn start<F, Fut>(&mut self, file_path: &str, on_update: F)
    where
        F: Fn(FileMonitorEvent) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        let file_path_clone = file_path.to_string();

        let monitor = tokio::spawn(async move {
            let _ = Self::start_monitor(file_path_clone.as_str(), on_update).await;
        });

        if let Some(old_task) = self.task_holder.replace(monitor) {
            println!("Aborting old file monitor task");
            old_task.abort();
        }
    }

    pub async fn stop(&mut self) {
        if let Some(handle) = self.task_holder.take() {
            handle.abort();
        }
    }

    async fn start_monitor<F, Fut>(file_path: &str, on_update: F) -> Result<(), AppError>
    where
        F: Fn(FileMonitorEvent) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), AppError>> + Send + 'static,
    {
        while !Path::new(file_path).exists() {
            sleep(Duration::from_millis(10)).await;
        }

        let file = OpenOptions::new().read(true).open(file_path).await?;
        let mut reader = BufReader::new(file);

        let metadata = reader.get_ref().metadata().await.unwrap();
        let mut position = metadata.len();
        let mut inode = metadata.ino();

        loop {
            // mico_aivs_lab restart 会用新 inode 替换 instruction.log。仅比较
            // 文件大小无法发现这种情况，旧 reader 会永远读不到新的唤醒/ASR。
            let metadata = match tokio::fs::metadata(file_path).await {
                Ok(metadata) => metadata,
                Err(_) => {
                    sleep(Duration::from_millis(10)).await;
                    continue;
                }
            };
            if metadata.ino() != inode {
                let file = OpenOptions::new().read(true).open(file_path).await?;
                reader = BufReader::new(file);
                inode = metadata.ino();
                position = 0;
                let _ = on_update(FileMonitorEvent::NewFile).await;
            }

            let current_size = metadata.len();
            if current_size < position {
                position = 0;
                let _ = on_update(FileMonitorEvent::NewFile).await;
            }

            if reader.stream_position().await? != position {
                reader.seek(SeekFrom::Start(position)).await?;
            }

            let mut line = String::new();

            while let Ok(bytes_read) = reader.read_line(&mut line).await {
                if bytes_read == 0 {
                    break;
                }

                let trimmed_line = line.trim();
                if !trimmed_line.is_empty() {
                    let _ = on_update(FileMonitorEvent::NewLine(trimmed_line.to_string())).await;
                }

                position = reader.stream_position().await?;
                line.clear();
            }

            sleep(Duration::from_millis(10)).await;
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;
    use tokio::time::timeout;

    // 用真实临时文件验证轮转，不依赖音箱或注入语音。先等读循环就绪，
    // 再原子替换日志，确保新 inode 的第一条指令不会被跳过。
    #[tokio::test]
    async fn follows_replaced_log_and_subsequent_appends() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        tokio::fs::create_dir(&directory).await.unwrap();
        let path = directory.join("instruction.log");
        tokio::fs::write(&path, "history\n").await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut monitor = FileMonitor::new();
        monitor.start(path.to_str().unwrap(), move |event| {
            let tx = tx.clone();
            async move { let _ = tx.send(event); Ok(()) }
        }).await;
        timeout(Duration::from_secs(3), async {
            loop {
                let mut file = OpenOptions::new().append(true).open(&path).await.unwrap();
                file.write_all(b"ready\n").await.unwrap();
                sleep(Duration::from_millis(20)).await;
                if let Ok(FileMonitorEvent::NewLine(line)) = rx.try_recv() {
                    assert_eq!(line, "ready");
                    break;
                }
            }
        }).await.expect("监视器没有进入读取循环");
        let replacement = directory.join("replacement.log");
        tokio::fs::write(&replacement, "new-first\n").await.unwrap();
        tokio::fs::rename(&replacement, &path).await.unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                if let Some(FileMonitorEvent::NewLine(line)) = rx.recv().await {
                    if line == "new-first" { break; }
                }
            }
        }).await.expect("替换日志后没有读取新文件第一行");
        let mut file = OpenOptions::new().append(true).open(&path).await.unwrap();
        file.write_all(b"new-second\n").await.unwrap();
        timeout(Duration::from_secs(3), async {
            loop {
                if let Some(FileMonitorEvent::NewLine(line)) = rx.recv().await {
                    if line == "new-second" { break; }
                }
            }
        }).await.expect("没有读取新日志追加行");
        monitor.stop().await;
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
}
