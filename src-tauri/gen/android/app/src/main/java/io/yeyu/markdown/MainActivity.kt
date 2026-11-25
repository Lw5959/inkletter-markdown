package io.yeyu.markdown

import android.os.Bundle
import android.os.Build
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
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
    val content = findViewById<View>(android.R.id.content)
    // 让 WebView 的实际尺寸随系统栏、挖孔和键盘变化，工具栏留在可点击区域。
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, keyboard.bottom))
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
