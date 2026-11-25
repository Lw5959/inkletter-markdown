package io.yeyu.markdown

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.core.view.WindowCompat
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.concurrent.ConcurrentHashMap

@InvokeArg
class PickDocumentArgs { var name: String? = null }

@InvokeArg
class DescriptorArgs { lateinit var uri: String; var write: Boolean = false }

@InvokeArg
class AppearanceArgs { var light: Boolean = true; lateinit var color: String }

@InvokeArg
class UpdateArgs { lateinit var url: String }

@TauriPlugin
class MarkdownDocuments(private val activity: Activity) : Plugin(activity) {
    private val grants = ConcurrentHashMap<Uri, Int>()

    @Command
    fun pickDocument(invoke: Invoke) {
        try {
            val name = invoke.parseArgs(PickDocumentArgs::class.java).name
            val intent = Intent(if (name == null) Intent.ACTION_OPEN_DOCUMENT else Intent.ACTION_CREATE_DOCUMENT)
            intent.addCategory(Intent.CATEGORY_OPENABLE)
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
            if (name == null) {
                // 部分文件提供方把 .md 上报为普通文本或二进制，打开时由 Rust 验证 UTF-8。
                intent.type = "*/*"
                intent.putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("text/*", "application/octet-stream"))
            } else {
                intent.type = "text/markdown"
                intent.putExtra(Intent.EXTRA_TITLE, name)
            }
            startActivityForResult(invoke, intent, "documentPicked")
        } catch (error: Exception) {
            invoke.reject("无法打开系统文件选择器", error)
        }
    }

    @ActivityCallback
    fun documentPicked(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            invoke.resolve(JSObject())
            return
        }
        val uri = data.data
        if (uri == null || uri.scheme != "content") {
            invoke.reject("文件提供方没有返回可访问的文档")
            return
        }
        val flags = data.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        grants[uri] = (grants[uri] ?: 0) or flags
        try {
            activity.contentResolver.takePersistableUriPermission(uri, flags)
        } catch (_: SecurityException) {
            // 提供方仅授予临时访问时，仍可在当前会话中打开。
        }
        invoke.resolve(JSObject().put("uri", uri.toString()))
    }

    @Command
    fun descriptor(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(DescriptorArgs::class.java)
            val uri = Uri.parse(args.uri)
            val resolver = activity.contentResolver
            val granted = resolver.persistedUriPermissions.firstOrNull { it.uri == uri }
            val flags = grants[uri] ?: 0
            val canRead = granted?.isReadPermission == true || (flags and Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0
            val canWrite = granted?.isWritePermission == true || (flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0
            if (uri.scheme != "content" || !canRead || (args.write && !canWrite)) {
                invoke.reject("文档访问权限已失效或文件为只读，请重新打开文件或另存副本")
                return
            }
            val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: "未命名.md"
            val fd = resolver.openFileDescriptor(uri, if (args.write) "rw" else "r")?.use { it.detachFd() }
            if (fd == null) {
                invoke.reject("文件提供方没有返回本机可读的文档")
                return
            }
            invoke.resolve(JSObject().put("fd", fd).put("name", name).put("writable", canWrite))
        } catch (error: Exception) {
            invoke.reject("无法访问文档，请检查文件位置和权限", error)
        }
    }

    @Command
    fun appearance(invoke: Invoke) {
        val args = invoke.parseArgs(AppearanceArgs::class.java)
        activity.runOnUiThread {
            try {
                val content = activity.findViewById<android.view.View>(android.R.id.content)
                content.setBackgroundColor(Color.parseColor(args.color))
                val bars = WindowCompat.getInsetsController(activity.window, content)
                bars.isAppearanceLightStatusBars = args.light
                bars.isAppearanceLightNavigationBars = args.light
                invoke.resolve()
            } catch (error: IllegalArgumentException) {
                invoke.reject("无法应用系统栏配色", error)
            }
        }
    }

    @Command
    fun downloadUpdate(invoke: Invoke) {
        try {
            val uri = Uri.parse(invoke.parseArgs(UpdateArgs::class.java).url)
            val path = uri.path.orEmpty()
            if (uri.scheme != "https" || uri.host != "github.com" ||
                !path.startsWith("/Lw5959/yeyu/releases/download/") || !path.endsWith("_android-arm64.apk")) {
                invoke.reject("更新地址与页屿 GitHub 发布仓库不匹配")
                return
            }
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("无法打开 GitHub APK 下载", error)
        }
    }
}
