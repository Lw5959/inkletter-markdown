package io.yeyu.markdown

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import androidx.annotation.Keep
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Keep
@InvokeArg
class AiCredentialArgs {
    lateinit var account: String
    var secret: String? = null
}

@Keep
@TauriPlugin
class AiCredentials(private val activity: Activity) : Plugin(activity) {
    private companion object {
        const val STORE = "AndroidKeyStore"
        const val ALIAS = "io.yeyu.markdown.ai.v1"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        val ACCOUNT = Regex("[a-f0-9-]{36}|[a-f0-9]{64}")
    }

    private fun encryptedFile(account: String): AtomicFile {
        require(ACCOUNT.matches(account))
        // 文件只保留随机 IV 与密文。换机备份不包含设备上的 Keystore 密钥和这些密文。
        return AtomicFile(File(activity.noBackupFilesDir, "ai-credential-$account"))
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        check(create)
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE).apply {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build()
            )
        }.generateKey()
    }

    @Command
    fun readSecret(invoke: Invoke) {
        try {
            val account = invoke.parseArgs(AiCredentialArgs::class.java).account
            val bytes = try {
                encryptedFile(account).readFully()
            } catch (_: FileNotFoundException) {
                invoke.resolve(JSObject())
                return
            }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES))
                updateAAD(account.toByteArray(Charsets.UTF_8))
            }
            val secret = cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES).toString(Charsets.UTF_8)
            invoke.resolve(JSObject().put("secret", secret))
        } catch (_: Exception) {
            invoke.reject("无法读取 Android 系统凭据")
        }
    }

    @Command
    fun writeSecret(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(AiCredentialArgs::class.java)
            val file = encryptedFile(args.account)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, key(create = true))
                // 将密文绑定到这一条凭据引用，避免误用其他供应商的密文。
                updateAAD(args.account.toByteArray(Charsets.UTF_8))
            }
            val ciphertext = cipher.doFinal(requireNotNull(args.secret).toByteArray(Charsets.UTF_8))
            val out = file.startWrite()
            try {
                out.write(cipher.iv)
                out.write(ciphertext)
            } catch (error: Exception) {
                file.failWrite(out)
                throw error
            }
            file.finishWrite(out)
            check(file.baseFile.isFile)
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法写入 Android 系统凭据")
        }
    }

    @Command
    fun deleteSecret(invoke: Invoke) {
        try {
            val account = invoke.parseArgs(AiCredentialArgs::class.java).account
            val file = encryptedFile(account)
            file.delete()
            check(!file.baseFile.exists())
            invoke.resolve()
        } catch (_: Exception) {
            invoke.reject("无法删除 Android 系统凭据")
        }
    }
}
