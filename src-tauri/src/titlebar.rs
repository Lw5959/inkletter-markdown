use crate::store::err;
use objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained, runtime::AnyClass};
use objc2_app_kit::{
    NSAutoresizingMaskOptions as Resize, NSUserInterfaceItemIdentification, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow, NSWindowOrderingMode,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, ns_string};
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

const HEIGHT: f64 = 44.;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Material {
    Frosted,
    Liquid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitlebarView {
    material: Material,
    liquid_available: bool,
}

fn apply(root: &NSView, mtm: MainThreadMarker, material: Material) -> TitlebarView {
    let marker = ns_string!("io.yeyu.titlebar");
    for view in &root.subviews() {
        if view.identifier().as_deref() == Some(marker) {
            view.removeFromSuperview();
        }
    }
    let bounds = root.bounds();
    let flipped = root.isFlipped();
    let top = if flipped {
        bounds.origin.y
    } else {
        bounds.origin.y + bounds.size.height - HEIGHT
    };
    let frame = NSRect::new(
        NSPoint::new(bounds.origin.x, top),
        NSSize::new(bounds.size.width, HEIGHT),
    );
    let margin = if flipped {
        Resize::ViewMaxYMargin
    } else {
        Resize::ViewMinYMargin
    };
    let backdrop = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), frame);
    backdrop.setMaterial(NSVisualEffectMaterial::Titlebar);
    backdrop.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    backdrop.setState(NSVisualEffectState::FollowsWindowActiveState);
    backdrop.setAutoresizingMask(Resize::ViewWidthSizable | margin);
    backdrop.setIdentifier(Some(marker));
    root.addSubview_positioned_relativeTo(&backdrop, NSWindowOrderingMode::Below, None);

    // 在运行时查找系统类，让同一构建在 macOS 26 之前安全加载并使用毛玻璃。
    let glass_class = AnyClass::get(c"NSGlassEffectView");
    let liquid_available = glass_class.is_some();
    let material = match (material, glass_class) {
        (Material::Liquid, Some(class)) => {
            // Liquid Glass 在 AppKit 层合成，透明 WebView 仍然接收编辑器和工具按钮事件。
            let glass: Retained<NSView> = unsafe { msg_send![class, new] };
            let content = NSView::new(mtm);
            unsafe {
                let _: () = msg_send![&*glass, setContentView: &*content];
                let _: () = msg_send![&*glass, setCornerRadius: 0.0_f64];
            }
            glass.setFrame(frame);
            glass.setAutoresizingMask(Resize::ViewWidthSizable | margin);
            glass.setIdentifier(Some(marker));
            root.addSubview_positioned_relativeTo(
                &glass,
                NSWindowOrderingMode::Above,
                Some(&backdrop),
            );
            Material::Liquid
        }
        _ => Material::Frosted,
    };
    TitlebarView {
        material,
        liquid_available,
    }
}

#[tauri::command]
pub async fn titlebar_apply(
    window: WebviewWindow,
    material: Material,
) -> Result<TitlebarView, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let mtm = MainThreadMarker::new().ok_or("标题栏需要在主线程配置")?;
                let window = unsafe { webview.ns_window().cast::<NSWindow>().as_ref() }
                    .ok_or("未找到 macOS 窗口")?;
                let root = window.contentView().ok_or("未找到 macOS 窗口内容视图")?;
                Ok(apply(&root, mtm, material))
            })();
            let _ = sender.send(result);
        })
        .map_err(err)?;
    receiver.await.map_err(err)?
}

#[cfg(feature = "qa")]
#[tauri::command]
pub async fn qa_titlebar(window: WebviewWindow) -> Result<serde_json::Value, String> {
    use objc2_app_kit::{NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility};
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let window = unsafe { webview.ns_window().cast::<NSWindow>().as_ref() }
                    .ok_or("未找到验收窗口")?;
                let root = window.contentView().ok_or("未找到验收窗口的内容视图")?;
                let mut effects = Vec::new();
                for view in &root.subviews() {
                    if view.identifier().as_deref() == Some(ns_string!("io.yeyu.titlebar")) {
                        effects.push(view.class().name().to_string_lossy().into_owned());
                    }
                }
                let outer = root.bounds();
                let button_centers: Vec<f64> = [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ]
                .into_iter()
                .filter_map(|kind| window.standardWindowButton(kind))
                .map(|button| {
                    let rect = button.convertRect_toView(button.bounds(), Some(&root));
                    let center = rect.origin.y + rect.size.height / 2.;
                    if root.isFlipped() {
                        center - outer.origin.y
                    } else {
                        outer.origin.y + outer.size.height - center
                    }
                })
                .collect();
                Ok(serde_json::json!({
                    "effects": effects,
                    "buttonCenters": button_centers,
                    "targetCenter": HEIGHT / 2.,
                    "overlay": window.styleMask().contains(NSWindowStyleMask::FullSizeContentView),
                    "hiddenTitle": window.titleVisibility() == NSWindowTitleVisibility::Hidden,
                    "transparent": !window.isOpaque(),
                }))
            })();
            let _ = sender.send(result);
        })
        .map_err(err)?;
    receiver.await.map_err(err)?
}
