use tauri::{
    AppHandle, Emitter, EventTarget, Wry,
    menu::{AboutMetadata, HELP_SUBMENU_ID, Menu, MenuEvent, SubmenuBuilder, WINDOW_SUBMENU_ID},
};

const HIDE_APP: &str = "yeyu:hide-app";
const MENU_ACTION_EVENT: &str = "yeyu:menu-action";

pub fn build(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadata {
        name: Some("页屿".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let application = SubmenuBuilder::new(app, "页屿")
        .about_with_text("关于页屿", Some(about))
        .text("check-update", "检查更新…")
        .separator()
        .services_with_text("服务")
        .separator()
        // ⌘H 由页屿用于文内替换，隐藏应用仍可从菜单调用。
        .text(HIDE_APP, "隐藏页屿")
        .hide_others_with_text("隐藏其他应用")
        .show_all_with_text("全部显示")
        .separator()
        .quit_with_text("退出页屿")
        .build()?;

    // 文档动作的快捷键由前端管理，此处只添加菜单入口。
    let file = SubmenuBuilder::new(app, "文件")
        .text("new", "新建文档")
        .text("open", "打开文件…")
        .text("open-folder", "打开文件夹…")
        .separator()
        .text("save", "保存")
        .text("save-as", "另存为…")
        .separator()
        .text("print", "打印…")
        .separator()
        .close_window_with_text("关闭窗口")
        .build()?;

    let edit = SubmenuBuilder::new(app, "编辑")
        .undo_with_text("撤销")
        .redo_with_text("重做")
        .separator()
        .cut_with_text("剪切")
        .copy_with_text("复制")
        .paste_with_text("粘贴")
        .select_all_with_text("全选")
        .build()?;
    let view = SubmenuBuilder::new(app, "视图")
        .fullscreen_with_text("切换全屏")
        .build()?;

    // 使用 Tauri 约定的 ID，让 AppKit 管理窗口列表及帮助搜索。
    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "窗口")
        .minimize_with_text("最小化")
        .maximize_with_text("缩放")
        .separator()
        .bring_all_to_front_with_text("将所有窗口移到前面")
        .build()?;
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "帮助").build()?;

    Menu::with_items(app, &[&application, &file, &edit, &view, &window, &help])
}

pub fn handle_event(app: &AppHandle<Wry>, event: MenuEvent) {
    let action = event.id().as_ref();
    match action {
        HIDE_APP => {
            if let Err(error) = app.hide() {
                eprintln!("隐藏页屿失败：{error}");
            }
        }
        "check-update" | "new" | "open" | "open-folder" | "save" | "save-as" | "print" => {
            let Some(window) = crate::windows::front_editor(app) else {
                return;
            };
            if let Err(error) = app.emit_to(
                EventTarget::webview_window(window.label()),
                MENU_ACTION_EVENT,
                action,
            ) {
                eprintln!("发送原生菜单操作 {action} 失败：{error}");
            }
        }
        _ => {}
    }
}
