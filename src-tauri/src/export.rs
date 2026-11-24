use crate::store::{atomic_write, canonical, err};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    env, fs,
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};

pub fn executable(env_var: &str, names: &[&str], known: &[PathBuf]) -> Option<PathBuf> {
    env::var_os(env_var)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| {
            env::var_os("PATH")
                .into_iter()
                .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
                .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
                .chain(known.iter().cloned())
                .find(|path| path.is_file())
        })
}

fn chrome() -> Result<PathBuf, String> {
    let mut known = Vec::new();
    #[cfg(target_os = "macos")]
    for (app, exec) in [
        ("Google Chrome", "Google Chrome"),
        ("Chromium", "Chromium"),
        ("Microsoft Edge", "Microsoft Edge"),
    ] {
        known.push(PathBuf::from(format!(
            "/Applications/{app}.app/Contents/MacOS/{exec}"
        )));
        if let Some(home) = env::var_os("HOME") {
            known.push(
                PathBuf::from(home).join(format!("Applications/{app}.app/Contents/MacOS/{exec}")),
            );
        }
    }
    #[cfg(target_os = "windows")]
    for base in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(env::var_os)
    {
        for file in [
            "Microsoft/Edge/Application/msedge.exe",
            "Google/Chrome/Application/chrome.exe",
            "Chromium/Application/chrome.exe",
        ] {
            known.push(PathBuf::from(&base).join(file));
        }
    }
    #[cfg(target_os = "linux")]
    known.extend(
        [
            "/usr/bin/chromium",
            "/usr/bin/google-chrome",
            "/usr/bin/microsoft-edge",
            "/snap/bin/chromium",
        ]
        .map(PathBuf::from),
    );
    executable(
        "YEYU_CHROME",
        &[
            "chromium",
            "chromium-browser",
            "google-chrome",
            "microsoft-edge",
            "msedge.exe",
            "chrome.exe",
        ],
        &known,
    )
    .ok_or_else(|| "PDF 和图片导出需要已安装的 Chrome、Chromium 或 Edge".into())
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = &mut command;
    command
}

struct Browser {
    child: Child,
    cache: tempfile::TempDir,
}

impl Browser {
    fn launch() -> Result<Self, String> {
        let cache = tempfile::tempdir().map_err(err)?;
        let child = command(chrome()?)
            .args([
                "--headless=new",
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--no-proxy-server",
                "--disable-background-networking",
                "--disable-extensions",
                "--allow-file-access-from-files",
            ])
            .arg(format!("--user-data-dir={}", cache.path().display()))
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(err)?;
        Ok(Self { child, cache })
    }

    fn connect(&mut self) -> Result<DevTools, String> {
        let deadline = Instant::now() + Duration::from_secs(12);
        let port_file = self.cache.path().join("DevToolsActivePort");
        loop {
            if let Ok(content) = fs::read_to_string(&port_file) {
                let mut lines = content.lines();
                let port: u16 = lines
                    .next()
                    .and_then(|value| value.parse().ok())
                    .ok_or("浏览器调试端口无效")?;
                let endpoint = lines
                    .next()
                    .filter(|path| path.starts_with("/devtools/browser/"))
                    .ok_or("浏览器调试路径无效")?;
                let tcp = TcpStream::connect_timeout(
                    &([127, 0, 0, 1], port).into(),
                    Duration::from_secs(5),
                )
                .map_err(err)?;
                tcp.set_read_timeout(Some(Duration::from_secs(35)))
                    .map_err(err)?;
                tcp.set_write_timeout(Some(Duration::from_secs(10)))
                    .map_err(err)?;
                let socket = tungstenite::client(format!("ws://127.0.0.1:{port}{endpoint}"), tcp)
                    .map_err(err)?
                    .0;
                return Ok(DevTools {
                    socket,
                    next_id: 0,
                    session: None,
                });
            }
            if self.child.try_wait().map_err(err)?.is_some() || Instant::now() >= deadline {
                return Err("浏览器未能启动导出".into());
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct DevTools {
    socket: WebSocket<TcpStream>,
    next_id: u64,
    session: Option<String>,
}

impl DevTools {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let mut request = json!({"id":self.next_id,"method":method,"params":params});
        if let Some(id) = &self.session {
            request["sessionId"] = json!(id);
        }
        self.socket
            .send(Message::Text(request.to_string().into()))
            .map_err(err)?;
        loop {
            let message = self.socket.read().map_err(err)?;
            if let Message::Text(text) = message {
                let response: Value = serde_json::from_str(&text).map_err(err)?;
                if response["id"].as_u64() == Some(self.next_id) {
                    if let Some(error) = response.get("error") {
                        return Err(format!("浏览器导出失败：{error}"));
                    }
                    return Ok(response["result"].clone());
                }
            }
        }
    }
}

fn export_visual(path: &Path, html: &str, format: &str) -> Result<(), String> {
    let mut browser = Browser::launch()?;
    let html_path = browser.cache.path().join("document.html");
    fs::write(&html_path, html).map_err(err)?;
    let url = reqwest::Url::from_file_path(&html_path).map_err(|_| "导出临时路径无效")?;
    let mut dev = browser.connect()?;
    let target = dev.call("Target.createTarget", json!({"url":"about:blank"}))?;
    let session = dev.call(
        "Target.attachToTarget",
        json!({"targetId":target["targetId"],"flatten":true}),
    )?;
    dev.session = Some(
        session["sessionId"]
            .as_str()
            .ok_or("浏览器未建立导出会话")?
            .to_owned(),
    );
    dev.call("Page.enable", json!({}))?;
    dev.call(
        "Emulation.setDeviceMetricsOverride",
        json!({"width":1240,"height":900,"deviceScaleFactor":1,"mobile":false}),
    )?;
    let result = dev.call("Page.navigate", json!({"url":url.as_str()}))?;
    if let Some(error) = result["errorText"].as_str() {
        return Err(error.to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let ready = dev.call("Runtime.evaluate", json!({
            "expression":"(async()=>{if(!document.querySelector('#write'))return false; if(document.readyState!=='complete')await new Promise(resolve=>window.addEventListener('load',resolve,{once:true})); await document.fonts.ready; return true})()",
            "awaitPromise":true,"returnByValue":true
        }));
        if ready.is_ok_and(|result| result["result"]["value"] == true) {
            break;
        }
        if Instant::now() >= deadline {
            return Err("导出视图加载超时".into());
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let result = if format == "pdf" {
        dev.call(
            "Page.printToPDF",
            json!({"printBackground":true,"preferCSSPageSize":true,
            "marginTop":0,"marginBottom":0,"marginLeft":0,"marginRight":0}),
        )?
    } else {
        let region = dev.call("Runtime.evaluate", json!({
            "expression":"(()=>{const el=document.querySelector('#write'); const box=el.getBoundingClientRect(); return {x:Math.max(0,box.x),y:Math.max(0,box.y),width:Math.ceil(box.width),height:Math.ceil(box.height)}})()",
            "returnByValue":true
        }))?;
        let mut clip = region["result"]["value"].clone();
        let height = clip["height"].as_f64().unwrap_or(0.0);
        let width = clip["width"].as_f64().unwrap_or(0.0);
        if height < 1.0 || width < 1.0 || height > 32000.0 || height * width > 64_000_000.0 {
            return Err("文档尺寸超过图片导出范围，请改用 PDF".into());
        }
        clip["scale"] = json!(1);
        dev.call(
            "Page.captureScreenshot",
            json!({"format":"png","captureBeyondViewport":true,"clip":clip}),
        )?
    };
    let raw = result["data"].as_str().ok_or("浏览器没有返回导出数据")?;
    atomic_write(path, &STANDARD.decode(raw).map_err(err)?).map_err(err)
}

#[tauri::command]
pub async fn export_document(path: PathBuf, html: String, format: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match format.as_str() {
        "html" | "plain-html" => atomic_write(&path, html.as_bytes()).map_err(err),
        "pdf" | "png" => export_visual(&path, &html, &format),
        _ => Err("不支持的导出格式".into()),
    })
    .await
    .map_err(err)?
}

fn pandoc() -> Result<PathBuf, String> {
    executable(
        "YEYU_PANDOC",
        &["pandoc", "pandoc.exe"],
        &[
            PathBuf::from("/opt/homebrew/bin/pandoc"),
            PathBuf::from("/usr/local/bin/pandoc"),
            PathBuf::from("/usr/bin/pandoc"),
            PathBuf::from(r"C:\Program Files\Pandoc\pandoc.exe"),
        ],
    )
    .ok_or_else(|| "请先安装 Pandoc，再从文件菜单重试".into())
}

const PANDOC_FORMATS: &[&str] = &[
    "docx",
    "epub",
    "odt",
    "latex",
    "rtf",
    "rst",
    "textile",
    "opml",
    "revealjs",
    "json",
    "commonmark",
    "html",
];

#[tauri::command]
pub async fn pandoc_export(
    path: PathBuf,
    text: String,
    format: String,
    source: Option<PathBuf>,
) -> Result<(), String> {
    if !PANDOC_FORMATS.contains(&format.as_str()) {
        return Err("不支持的 Pandoc 导出格式".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let folder = path.parent().ok_or("缺少导出目录")?;
        let tmp = tempfile::NamedTempFile::new_in(folder).map_err(err)?;
        let mut process = command(pandoc()?);
        process
            .args([
                "--from=markdown+yaml_metadata_block+task_lists",
                "--standalone",
            ])
            .arg(format!("--to={format}"))
            .arg("--output")
            .arg(tmp.path())
            .stdin(Stdio::piped())
            .stderr(Stdio::piped())
            .stdout(Stdio::null());
        if let Some(dir) = source.as_deref().and_then(Path::parent) {
            process.current_dir(dir);
        }
        let mut child = process.spawn().map_err(err)?;
        let mut stdin = child.stdin.take().ok_or("Pandoc 输入不可用")?;
        let write = std::thread::spawn(move || {
            use std::io::Write;
            stdin.write_all(text.as_bytes())
        });
        let output = child.wait_with_output().map_err(err)?;
        let written = write.join().map_err(|_| "无法写入 Pandoc 输入")?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        written.map_err(err)?;
        tmp.as_file().sync_all().map_err(err)?;
        tmp.persist(&path).map_err(err)?;
        Ok(())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn pandoc_import(path: PathBuf, destination: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = canonical(&path).map_err(err)?;
        let destination_dir = destination.parent().ok_or("缺少保存目录")?;
        let stem = destination
            .file_stem()
            .ok_or("缺少文件名")?
            .to_string_lossy();
        let media = format!("{stem}.assets");
        let staging = tempfile::tempdir_in(destination_dir).map_err(err)?;
        let output = command(pandoc()?)
            .current_dir(staging.path())
            .arg(&path)
            .args([
                "--to=markdown+yaml_metadata_block+task_lists",
                "--wrap=none",
            ])
            .arg(format!("--extract-media={media}"))
            .output()
            .map_err(err)?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        let staged = staging.path().join(&media);
        let target = destination_dir.join(media);
        let moved_media = if staged.exists() {
            if target.symlink_metadata().is_ok() {
                return Err("导入资源目录与已有目录重名，请使用其他文件名".into());
            }
            fs::rename(&staged, &target).map_err(err)?;
            true
        } else {
            false
        };
        if let Err(error) = atomic_write(&destination, &output.stdout) {
            if moved_media {
                let _ = fs::rename(&target, &staged);
            }
            return Err(err(error));
        }
        Ok(())
    })
    .await
    .map_err(err)?
}
