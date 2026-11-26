#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod assets;
mod associations;
mod document_bytes;
mod export;
mod files;
mod mcp;
#[cfg(target_os = "macos")]
mod native_menu;
mod plugins;
#[cfg(feature = "qa")]
mod qa;
mod settings;
mod store;
mod themes;
#[cfg(target_os = "macos")]
mod titlebar;
mod typora;
mod updates;
mod windows;
mod workspace;

use std::{path::PathBuf, time::Duration};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn print_document(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(store::err)
}

#[tauri::command]
fn visit_link(url: String, app: tauri::AppHandle) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(store::err)?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("不支持此链接协议".into());
    }
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(store::err)
}

fn main() {
    let mut arguments = std::env::args_os().skip(1).peekable();
    if arguments.peek().is_some_and(|arg| arg == "--mcp") {
        arguments.next();
        let mut root = None;
        let mut data = None;
        while let Some(flag) = arguments.next() {
            match flag.to_str() {
                Some("--workspace") => root = arguments.next().map(PathBuf::from),
                Some("--state-dir") => data = arguments.next().map(PathBuf::from),
                _ => break,
            }
        }
        let result = match (root, data) {
            (Some(root), Some(data)) => tauri::async_runtime::block_on(mcp::serve(root, data)),
            _ => Err("用法：yeyu --mcp --workspace <目录> --state-dir <应用数据目录>".into()),
        };
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    let launch = windows::argument_paths(
        arguments.map(PathBuf::from),
        &std::env::current_dir().unwrap_or_default(),
    );
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let paths = windows::argument_paths(
                    args.into_iter().skip(1).map(PathBuf::from),
                    std::path::Path::new(&cwd),
                );
                if paths.is_empty() {
                    if let Some(window) = windows::front_editor(&handle) {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                } else if let Err(error) = windows::open_paths(&handle, paths, None, None) {
                    eprintln!("打开文档失败：{error}");
                }
            });
        }));
    #[cfg(target_os = "linux")]
    let builder = builder.manage(updates::package::Downloads::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(native_menu::build)
        .on_menu_event(native_menu::handle_event);
    let app = builder
        .manage(files::SaveLock::default())
        .manage(themes::ThemeImports::default())
        .manage(ai::Jobs::default())
        .manage(ai::config::Models::default())
        .manage(mcp::Sessions::default())
        .manage(plugins::Plugins::default())
        .manage(plugins::market::Market::default())
        .manage(windows::Windows::default())
        .manage(settings::SettingsLock::default())
        .manage(
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("HTTP 客户端初始化失败"),
        )
        .setup(move |app| {
            let data = app.path().app_data_dir()?;
            #[cfg(feature = "qa")]
            let data = qa::directory()
                .map(|folder| folder.join("app-data"))
                .unwrap_or(data);
            app.manage(store::Store(data.clone()));
            windows::startup(app.handle(), &data, launch).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            windows::on_window_event(window.label(), window.app_handle(), event)
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "qa")]
            qa::qa_config,
            #[cfg(feature = "qa")]
            qa::qa_report,
            #[cfg(feature = "qa")]
            qa::qa_input,
            #[cfg(feature = "qa")]
            qa::qa_windows,
            #[cfg(feature = "qa")]
            qa::qa_move_window,
            #[cfg(all(feature = "qa", target_os = "macos"))]
            titlebar::qa_titlebar,
            files::open_document,
            files::document_version,
            files::save_document,
            files::load_recovery,
            files::save_recovery,
            settings::settings_load,
            settings::settings_save,
            settings::settings_recent,
            windows::document_windows_open,
            windows::desktop_panel_close,
            windows::desktop_panel_resize,
            windows::document_window_request,
            windows::document_window_state,
            windows::document_window_new,
            windows::document_quit_cancel,
            updates::update_package,
            updates::update_check,
            updates::update_install,
            #[cfg(target_os = "linux")]
            updates::package::update_check_package,
            #[cfg(target_os = "linux")]
            updates::package::update_download_package,
            #[cfg(target_os = "linux")]
            updates::package::update_open_package,
            #[cfg(target_os = "linux")]
            updates::package::update_save_package,
            associations::markdown_default,
            #[cfg(target_os = "macos")]
            titlebar::titlebar_apply,
            workspace::workspace_root,
            workspace::workspace_tree,
            workspace::workspace_search,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_trash,
            themes::theme_begin,
            themes::theme_read,
            themes::theme_finish,
            themes::theme_abort,
            themes::theme_list,
            themes::typora_theme_paths,
            typora::typora_profiles,
            assets::image_data,
            assets::image_insert,
            assets::image_copy,
            assets::image_fingerprints,
            assets::image_collect,
            assets::image_remove,
            assets::image_upload,
            export::export_document,
            export::pandoc_import,
            export::pandoc_export,
            print_document,
            visit_link,
            ai::config::ai_settings,
            ai::config::ai_provider_save,
            ai::config::ai_provider_remove,
            ai::config::ai_model_select,
            ai::ai_list_models,
            ai::ai_stream,
            ai::agent::ai_agent_turn,
            ai::ai_conversations,
            ai::ai_cancel,
            plugins::plugin_list,
            plugins::plugin_install,
            plugins::plugin_set_enabled,
            plugins::plugin_remove,
            plugins::plugin_run,
            plugins::market::plugin_market_list,
            plugins::market::plugin_market_install,
            mcp::mcp_connect,
            mcp::mcp_disconnect,
            mcp::mcp_connected,
            mcp::mcp_call,
            mcp::mcp_local,
            mcp::mcp_selection,
            mcp::mcp_proposals,
            mcp::mcp_resolve,
        ])
        .build(tauri::generate_context!())
        .expect("无法启动页屿");

    app.run(|_app, _event| {
        if let tauri::RunEvent::ExitRequested {
            code: None,
            ref api,
            ..
        } = _event
            && windows::front_editor(_app).is_some()
        {
            api.prevent_exit();
            windows::request_quit(_app);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let app = _app.clone();
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .filter(|path| workspace::markdown(path))
                .collect();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = windows::open_paths(&app, paths, None, None) {
                    eprintln!("打开 Finder 文档失败：{error}");
                }
            });
        }
    });
}
