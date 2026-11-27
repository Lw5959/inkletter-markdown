use crate::store::err;
use block2::RcBlock;
use objc2::{
    MainThreadMarker, MainThreadOnly, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyClass, AnyObject, ProtocolObject},
    sel,
};
use objc2_app_kit::{
    NSAutoresizingMaskOptions as Resize, NSUserInterfaceItemIdentification, NSView,
    NSViewFrameDidChangeNotification, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
    NSVisualEffectState, NSVisualEffectView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_foundation::{
    NSError, NSNotification, NSNotificationCenter, NSObjectProtocol, NSPoint, NSRect, NSSize,
    ns_string,
};
use objc2_web_kit::{WKContentWorld, WKWebView};
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::HashMap, ptr::NonNull, time::Duration};
use tauri::{WebviewWindow, WindowEvent};
use tokio::sync::oneshot;

const HEIGHT: f64 = 44.;

struct ResizeObserver {
    webview: Weak<NSView>,
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    restore: Option<NSRect>,
    zooming: bool,
}

thread_local! {
    static RESIZE_OBSERVERS: RefCell<HashMap<String, ResizeObserver>> = RefCell::new(HashMap::new());
}

fn fit_webview(view: &NSView) {
    let Some(parent) = (unsafe { view.superview() }) else {
        return;
    };
    let bounds = parent.bounds();
    if view.frame() != bounds {
        view.setFrame(bounds);
        view.setNeedsLayout(true);
        view.layoutSubtreeIfNeeded();
    }
    view.setNeedsDisplay(true);
}

fn is_zooming(label: &str) -> bool {
    RESIZE_OBSERVERS.with(|items| {
        items
            .borrow()
            .get(label)
            .is_some_and(|observer| observer.zooming)
    })
}

pub fn sync_webview_on_resize(window: &WebviewWindow) {
    let label = window.label().to_owned();
    let setup_label = label.clone();
    let _ = window.with_webview(move |native| {
        let view = unsafe { &*native.inner().cast::<NSView>() };
        let Some(parent) = (unsafe { view.superview() }) else {
            return;
        };
        parent.setPostsFrameChangedNotifications(true);
        let lookup = setup_label.clone();
        let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
            if MainThreadMarker::new().is_none() || is_zooming(&lookup) {
                return;
            }
            let view = RESIZE_OBSERVERS.with(|observers| {
                observers
                    .borrow()
                    .get(&lookup)
                    .and_then(|observer| observer.webview.load())
            });
            if let Some(view) = view {
                fit_webview(&view);
            }
        });
        // AppKit 在调整宿主尺寸时同步发通知。Tauri 的 Resized 回调可能排到放大动画之后。
        let token = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSViewFrameDidChangeNotification),
                Some(&parent),
                None,
                &callback,
            )
        };
        RESIZE_OBSERVERS.with(|observers| {
            observers.borrow_mut().insert(
                setup_label,
                ResizeObserver {
                    webview: Weak::new(view),
                    token,
                    restore: None,
                    zooming: false,
                },
            )
        });
        fit_webview(view);
    });
    let webview = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let label = label.clone();
            let _ = webview.run_on_main_thread(move || {
                if let Some(observer) =
                    RESIZE_OBSERVERS.with(|observers| observers.borrow_mut().remove(&label))
                {
                    unsafe {
                        NSNotificationCenter::defaultCenter()
                            .removeObserver(observer.token.as_ref())
                    };
                }
            });
        } else if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            let label = label.clone();
            let _ = webview.with_webview(move |native| {
                if !is_zooming(&label) {
                    fit_webview(unsafe { &*native.inner().cast::<NSView>() });
                }
            });
        }
    });
}

fn same_frame(a: NSRect, b: NSRect) -> bool {
    (a.origin.x - b.origin.x).abs() <= 1.
        && (a.origin.y - b.origin.y).abs() <= 1.
        && (a.size.width - b.size.width).abs() <= 1.
        && (a.size.height - b.size.height).abs() <= 1.
}

async fn prepare_expansion(window: &WebviewWindow, frame: NSRect) -> Result<(), String> {
    let (ready, painted) = oneshot::channel();
    window.with_webview(move |native| {
        let Some(mtm) = MainThreadMarker::new() else { return; };
        let view = unsafe { &*native.inner().cast::<WKWebView>() };
        if !view.respondsToSelector(sel!(callAsyncJavaScript:arguments:inFrame:inContentWorld:completionHandler:)) {
            return;
        }
        let window = unsafe { &*native.ns_window().cast::<NSWindow>() };
        let Some(parent) = (unsafe { view.superview() }) else { return; };
        let bounds = parent.bounds();
        let extent = window.contentRectForFrameRect(frame).size;
        let top = if parent.isFlipped() { bounds.origin.y } else { bounds.origin.y + bounds.size.height - extent.height };
        // 先在外框的裁切范围内扩大网页。临时保持上缘，绘制好后才露出新增区域。
        view.setFrame(NSRect::new(NSPoint::new(bounds.origin.x, top), extent));
        view.setNeedsLayout(true);
        view.layoutSubtreeIfNeeded();
        view.setNeedsDisplay(true);
        let ready = RefCell::new(Some(ready));
        let callback = RcBlock::new(move |_: *mut AnyObject, _: *mut NSError| {
            if let Some(ready) = ready.borrow_mut().take() { let _ = ready.send(()); }
        });
        // 第二次绘制回调在新布局提交后运行。后台窗口暂停回调时，外层超时会继续窗口更新。
        let script = ns_string!("await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));");
        unsafe { view.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(
            script, None, None, &WKContentWorld::pageWorld(mtm), Some(&callback),
        ) };
    }).map_err(err)?;
    let _ = tokio::time::timeout(Duration::from_millis(80), painted).await;
    Ok(())
}

#[tauri::command]
pub async fn titlebar_zoom(window: WebviewWindow, animate: bool) -> Result<(), String> {
    let label = window.label().to_owned();
    let lookup = label.clone();
    let (plan, ready) = oneshot::channel();
    window
        .with_webview(move |native| {
            let target = (|| {
                let window = unsafe { native.ns_window().cast::<NSWindow>().as_ref() }?;
                let view = unsafe { &*native.inner().cast::<NSView>() };
                let style = window.styleMask();
                if style.contains(NSWindowStyleMask::FullScreen)
                    || !style.contains(NSWindowStyleMask::Resizable)
                {
                    return None;
                }
                let screen = window.screen()?;
                let start = window.frame();
                let expanded = screen.visibleFrame();
                // 只在放大状态使用上一尺寸。手动拖动边框后，下一次放大会保存新的正常窗口。
                let finish = RESIZE_OBSERVERS.with(|observers| {
                    let mut observers = observers.borrow_mut();
                    let observer = observers.get_mut(&lookup)?;
                    if observer.zooming {
                        return None;
                    }
                    let frame = if same_frame(start, expanded) {
                        window.constrainFrameRect_toScreen(observer.restore.take()?, Some(&screen))
                    } else {
                        observer.restore = Some(start);
                        expanded
                    };
                    observer.zooming = true;
                    Some(frame)
                });
                // 系统或窗口管理器已放大时，AppKit 持有原尺寸。
                if finish.is_none()
                    && same_frame(start, expanded)
                    && window.isZoomed()
                    && !is_zooming(&lookup)
                {
                    window.zoom(None);
                }
                let finish = finish?;
                let mask = view.autoresizingMask();
                view.setAutoresizingMask(Resize::empty());
                Some((start, finish, mask))
            })();
            let _ = plan.send(target);
        })
        .map_err(err)?;
    let Some((start, finish, mask)) = ready.await.map_err(err)? else {
        return Ok(());
    };
    let growing = finish.size.width >= start.size.width && finish.size.height >= start.size.height;
    let steps = if animate { 8 } else { 1 };
    for step in 1..=steps {
        let progress = f64::from(step) / f64::from(steps);
        let done = step == steps;
        let frame = if done {
            finish
        } else {
            let eased = 1. - (1. - progress).powi(2);
            let blend = |from: f64, to: f64| (from + (to - from) * eased).round();
            NSRect::new(
                NSPoint::new(
                    blend(start.origin.x, finish.origin.x),
                    blend(start.origin.y, finish.origin.y),
                ),
                NSSize::new(
                    blend(start.size.width, finish.size.width),
                    blend(start.size.height, finish.size.height),
                ),
            )
        };
        if growing {
            prepare_expansion(&window, frame).await?;
        }
        let label = label.clone();
        let (applied, wait) = oneshot::channel();
        window
            .with_webview(move |native| {
                let view = unsafe { &*native.inner().cast::<NSView>() };
                if let Some(window) = unsafe { native.ns_window().cast::<NSWindow>().as_ref() } {
                    // 每次只改变一个真实窗口尺寸，把控制权交回 AppKit，WebKit 才能在下一帧重排正文。
                    if !same_frame(window.frame(), frame) || done {
                        window.setFrame_display(frame, true);
                    }
                }
                fit_webview(view);
                if done {
                    view.setAutoresizingMask(mask);
                    RESIZE_OBSERVERS.with(|observers| {
                        if let Some(observer) = observers.borrow_mut().get_mut(&label) {
                            observer.zooming = false;
                        }
                    });
                }
                let _ = applied.send(());
            })
            .map_err(err)?;
        wait.await.map_err(err)?;
        if !done && !growing {
            // 接住上一帧的窗口更新后再等一个显示周期，放大时也不会因首帧较重而跳过后续步骤。
            tokio::time::sleep(Duration::from_millis(17)).await;
        }
    }
    Ok(())
}

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
pub async fn qa_titlebar(
    window: WebviewWindow,
    hold_webview_size: Option<bool>,
) -> Result<serde_json::Value, String> {
    use objc2_app_kit::{NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility};
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let result = (|| {
                let window = unsafe { webview.ns_window().cast::<NSWindow>().as_ref() }
                    .ok_or("未找到验收窗口")?;
                let root = window.contentView().ok_or("未找到验收窗口的内容视图")?;
                let view = unsafe { webview.inner().cast::<NSView>().as_ref() }
                    .ok_or("未找到验收窗口的 WebView")?;
                // 复现 AppKit 窗口已放大、WebView 仍停在旧尺寸的情况。
                if hold_webview_size == Some(true) {
                    view.setAutoresizingMask(Resize::empty());
                }
                let mut effects = Vec::new();
                for view in &root.subviews() {
                    if view.identifier().as_deref() == Some(ns_string!("io.yeyu.titlebar")) {
                        effects.push(view.class().name().to_string_lossy().into_owned());
                    }
                }
                let outer = root.bounds();
                let content = window.contentRectForFrameRect(window.frame());
                let viewport = view.frame();
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
                    "contentSize": [content.size.width, content.size.height],
                    "rootSize": [outer.size.width, outer.size.height],
                    "webviewFrame": [viewport.origin.x, viewport.origin.y, viewport.size.width, viewport.size.height],
                    "zoomed": window.isZoomed(),
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
