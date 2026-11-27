use crate::store::err;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DefaultMarkdown {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    Applied,
    #[cfg(target_os = "windows")]
    SystemSettings,
    #[cfg(target_os = "macos")]
    Finder,
}

#[tauri::command]
pub async fn markdown_default(app: AppHandle) -> Result<DefaultMarkdown, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_opener::OpenerExt;

        // Windows 的默认应用由系统设置确认，安装程序只登记墨笺为候选项。
        app.opener()
            .open_url(
                "ms-settings:defaultapps?registeredAppUser=Yeyu",
                None::<&str>,
            )
            .map_err(err)?;
        Ok(DefaultMarkdown::SystemSettings)
    }
    #[cfg(target_os = "linux")]
    {
        use gio::prelude::AppInfoExt;

        let _ = app;
        const DESKTOP_ID: &str = "Yeyu.desktop";
        const MARKDOWN_MIME: &str = "text/markdown";
        let entry = gio::DesktopAppInfo::new(DESKTOP_ID).ok_or("请先安装墨笺的桌面入口")?;
        entry.set_as_default_for_type(MARKDOWN_MIME).map_err(err)?;
        let default = gio::AppInfo::default_for_type(MARKDOWN_MIME, false);
        if !default
            .and_then(|entry| entry.id())
            .is_some_and(|id| id == DESKTOP_ID)
        {
            return Err("桌面环境未切换默认应用，请在文件属性中选择 Yeyu".into());
        }
        Ok(DefaultMarkdown::Applied)
    }
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || macos::request(sender))
            .map_err(err)?;
        receiver.await.map_err(err)?
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{DefaultMarkdown, err};
    use block2::RcBlock;
    use objc2::sel;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSBundle, NSError, NSObjectProtocol, NSString, NSURL};
    use std::sync::Mutex;
    use tokio::sync::oneshot::Sender;

    type ResultSender = Sender<Result<DefaultMarkdown, String>>;

    pub fn request(reply: ResultSender) {
        let workspace = NSWorkspace::sharedWorkspace();
        if !workspace.respondsToSelector(
            sel!(setDefaultApplicationAtURL:toOpenContentTypeOfFileAtURL:completionHandler:),
        ) {
            let _ = reply.send(Ok(DefaultMarkdown::Finder));
            return;
        }
        let bundle = NSBundle::mainBundle();
        let application = bundle.bundleURL();
        if bundle.bundleIdentifier().is_none()
            || !application
                .pathExtension()
                .is_some_and(|extension| extension.to_string() == "app")
        {
            let _ = reply.send(Err("请先安装并打开墨笺应用，再设置默认打开方式".into()));
            return;
        }
        let sample = match tempfile::Builder::new().suffix(".md").tempfile() {
            Ok(sample) => sample,
            Err(error) => {
                let _ = reply.send(Err(err(error)));
                return;
            }
        };
        // 让系统从临时 .md 确定关联类型，避免取用用户当前正在编辑的文件。
        let sample_url =
            NSURL::fileURLWithPath(&NSString::from_str(&sample.path().to_string_lossy()));
        let installed = application.path();
        let already_default = move |workspace: &NSWorkspace, reference: &NSURL| {
            workspace
                .URLForApplicationToOpenURL(reference)
                .and_then(|url| url.path())
                == installed
        };
        if already_default(&workspace, &sample_url) {
            let _ = reply.send(Ok(DefaultMarkdown::Applied));
            return;
        }

        let reply = Mutex::new(Some(reply));
        let reference = sample_url.clone();
        let completion = RcBlock::new(move |error: *mut NSError| {
            // 系统确认结束前保留文件，回调后随临时文件句柄释放。
            let _ = &sample;
            let result = if already_default(&NSWorkspace::sharedWorkspace(), &reference) {
                Ok(DefaultMarkdown::Applied)
            } else if let Some(error) = unsafe { error.as_ref() } {
                Err(format!(
                    "系统未更改默认应用（{}）",
                    error.localizedDescription()
                ))
            } else {
                Err("系统未更改默认应用，请在 Finder 的打开方式中选择 Yeyu".into())
            };
            if let Some(reply) = reply.lock().ok().and_then(|mut slot| slot.take()) {
                let _ = reply.send(result);
            }
        });
        workspace.setDefaultApplicationAtURL_toOpenContentTypeOfFileAtURL_completionHandler(
            &application,
            &sample_url,
            Some(&completion),
        );
    }
}
