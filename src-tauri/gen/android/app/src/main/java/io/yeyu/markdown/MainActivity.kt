package io.yeyu.markdown

import android.os.Bundle
import android.os.Build
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject

class MainActivity : TauriActivity() {
  private var surface: WebView? = null
  internal var webInsets = JSObject().put("left", 0).put("top", 0).put("right", 0).put("bottom", 0)
    private set

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    surface = webView
    // 由系统在实际重绘时选择高刷新档位，空闲时仍可由设备降频。
    if (Build.VERSION.SDK_INT >= 35) {
      webView.post {
        val display = webView.display
        val current = display?.mode
        val fastest = display?.supportedModes?.asSequence()?.filter {
          current != null && it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight
        }?.maxOfOrNull { it.refreshRate }
        webView.requestedFrameRate = fastest?.takeIf { it > 60f } ?: View.REQUESTED_FRAME_RATE_CATEGORY_HIGH
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
    val content = findViewById<View>(android.R.id.content)
    // WebView 绘制在透明系统栏下。只由原生缩减键盘占用的高度，安全边距交给页面控件。
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      if (view.paddingBottom != keyboard.bottom) view.setPadding(0, 0, 0, keyboard.bottom)
      val density = resources.displayMetrics.density
      val next = JSObject()
        .put("left", safe.left / density)
        .put("top", safe.top / density)
        .put("right", safe.right / density)
        .put("bottom", ((safe.bottom - keyboard.bottom).coerceAtLeast(0)) / density)
      if (webInsets.toString() != next.toString()) {
        webInsets = next
        surface?.evaluateJavascript("window.dispatchEvent(new CustomEvent('yeyu:insets', { detail: $next }))", null)
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = surface
        fun systemBack() {
          isEnabled = false
          try { onBackPressedDispatcher.onBackPressed() } finally { isEnabled = true }
        }
        if (webView == null) systemBack()
        else webView.evaluateJavascript("window.dispatchEvent(new Event('yeyu:android-back', { cancelable: true }))") {
          // 页面取消此事件时，最上层弹窗或正在打开的文档已经接管返回手势。
          if (it != "false") systemBack()
        }
      }
    })
  }
}
