package io.yeyu.markdown

import android.os.Bundle
import android.os.Build
import android.view.View
import android.webkit.WebView
import androidx.activity.BackEventCompat
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject

class MainActivity : TauriActivity() {
  private var surface: WebView? = null
  private var interceptBack = false
  private var animateBack = false
  private var trackingBack = false
  private var pendingBackProgress: BackEventCompat? = null
  private val backFrame = Runnable {
    val progress = pendingBackProgress
    pendingBackProgress = null
    if (trackingBack && progress != null) sendBackGesture("progress", progress)
  }
  private val backCallback = object : OnBackPressedCallback(false) {
    override fun handleOnBackStarted(backEvent: BackEventCompat) {
      if (!animateBack || surface == null) return
      trackingBack = true
      sendBackGesture("start", backEvent)
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
      if (!trackingBack) return
      val needsFrame = pendingBackProgress == null
      pendingBackProgress = backEvent
      // 同一帧有多个进度事件时，只把最新进度送到 WebView。
      if (needsFrame) surface?.postOnAnimation(backFrame)
    }

    override fun handleOnBackCancelled() {
      val started = trackingBack
      clearBackFrame()
      if (started) sendBackGesture("cancel")
    }

    override fun handleOnBackPressed() {
      clearBackFrame()
      val webView = surface
      if (webView == null) giveBackToSystem()
      else webView.evaluateJavascript("window.dispatchEvent(new Event('yeyu:android-back', { cancelable: true }))") {
        if (it != "false") giveBackToSystem()
      }
    }
  }

  internal var webInsets = JSObject().put("left", 0).put("top", 0).put("right", 0).put("bottom", 0)
    private set

  internal fun setBackNavigation(enabled: Boolean, animated: Boolean) {
    if (!enabled || !animated) backCallback.handleOnBackCancelled()
    interceptBack = enabled
    animateBack = animated
    // 首页没有应用内返回目标时，由 Android 提供跨任务或回桌面的预览。
    backCallback.isEnabled = enabled
  }

  private fun clearBackFrame() {
    surface?.removeCallbacks(backFrame)
    pendingBackProgress = null
    trackingBack = false
  }

  private fun sendBackGesture(phase: String, event: BackEventCompat? = null) {
    val detail = JSObject().put("phase", phase)
      .put("edge", if (event?.swipeEdge == BackEventCompat.EDGE_RIGHT) "right" else "left")
      .put("progress", event?.progress?.toDouble() ?: 0.0)
    surface?.evaluateJavascript("window.dispatchEvent(new CustomEvent('yeyu:android-back-gesture', { detail: $detail }))", null)
  }

  private fun giveBackToSystem() {
    if (isFinishing || isDestroyed) return
    backCallback.isEnabled = false
    try { onBackPressedDispatcher.onBackPressed() } finally { backCallback.isEnabled = interceptBack && !isFinishing }
  }

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

    onBackPressedDispatcher.addCallback(this, backCallback)
  }

  override fun onDestroy() {
    clearBackFrame()
    surface = null
    super.onDestroy()
  }
}
