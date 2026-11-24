package com.toserbalokal.mobile

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private var serverBaseUrl = ""
    private var barcodeView: DecoratedBarcodeView? = null
    private var scannerDialog: AlertDialog? = null
    private var pendingScanMode = ""
    private val barcodeLock = Any()
    private var lastBarcode = ""
    private val scannerHandler = Handler(Looper.getMainLooper())
    private val clearBarcodeLock = Runnable { synchronized(barcodeLock) { lastBarcode = "" } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val savedUrl = getPreferences(Context.MODE_PRIVATE)
            .getString(SERVER_URL_KEY, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        val savedUri = runCatching { Uri.parse(savedUrl) }.getOrNull()
        serverBaseUrl = if (savedUri != null && isSafeServerUrl(savedUri)) {
            savedUrl.trimEnd('/')
        } else {
            DEFAULT_SERVER_URL
        }
        CookieManager.getInstance().setAcceptCookie(true)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(PAGE_COLOR)
        }
        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(6), dp(12), dp(6))
            setBackgroundColor(Color.WHITE)
            elevation = dp(3).toFloat()
        }
        toolbar.addView(TextView(this).apply {
            text = "TL"
            textSize = 16f
            gravity = Gravity.CENTER
            setTextColor(Color.WHITE)
            setBackgroundColor(GREEN)
        }, LinearLayout.LayoutParams(dp(38), dp(38)).apply { marginEnd = dp(10) })
        toolbar.addView(TextView(this).apply {
            text = "Toserba Lokal"
            textSize = 16f
            setTextColor(TEXT_COLOR)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        toolbar.addView(toolbarButton("Server") { showServerDialog() })
        toolbar.addView(toolbarButton("Muat ulang") { webView.reload() })
        toolbar.addView(toolbarButton("Keluar") {
            webView.evaluateJavascript("if(window.toserbaLogout)window.toserbaLogout();", null)
        })
        root.addView(toolbar)

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
        }
        root.addView(progressBar, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(2),
        ))

        webView = WebView(this).apply {
            setBackgroundColor(PAGE_COLOR)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadsImagesAutomatically = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.javaScriptCanOpenWindowsAutomatically = false
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar.progress = newProgress
                    progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (isTrustedServerUrl(uri)) return false
                    Toast.makeText(this@MainActivity, "Tautan dibuka di browser.", Toast.LENGTH_SHORT).show()
                    runCatching { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, uri)) }
                    return true
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: android.webkit.WebResourceError,
                ) {
                    super.onReceivedError(view, request, error)
                    if (request.isForMainFrame) {
                        Toast.makeText(
                            this@MainActivity,
                            "Tidak dapat terhubung ke server toko (${error.errorCode}): ${error.description}",
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    errorResponse: android.webkit.WebResourceResponse,
                ) {
                    super.onReceivedHttpError(view, request, errorResponse)
                    if (request.isForMainFrame) {
                        Toast.makeText(
                            this@MainActivity,
                            "Server toko menolak halaman: HTTP ${errorResponse.statusCode}.",
                            Toast.LENGTH_LONG,
                        ).show()
                    }
                }

                override fun onReceivedSslError(
                    view: WebView,
                    handler: SslErrorHandler,
                    error: SslError,
                ) {
                    handler.cancel()
                    val primaryError = when (error.primaryError) {
                        SslError.SSL_NOTYETVALID -> "sertifikat belum berlaku"
                        SslError.SSL_EXPIRED -> "sertifikat sudah kedaluwarsa"
                        SslError.SSL_IDMISMATCH -> "alamat IP tidak cocok dengan sertifikat"
                        SslError.SSL_UNTRUSTED -> "sertifikat/CA tidak dipercaya"
                        SslError.SSL_DATE_INVALID -> "tanggal sertifikat tidak valid"
                        SslError.SSL_INVALID -> "sertifikat tidak valid"
                        else -> "kesalahan sertifikat"
                    }
                    Toast.makeText(
                        this@MainActivity,
                        "Koneksi HTTPS ditolak: $primaryError. Pasang rootCA.pem yang digunakan server di Android.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
            addJavascriptInterface(AndroidBridge(), "ToserbaAndroid")
            setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    setMimeType(mimeType)
                    addRequestHeader("User-Agent", userAgent)
                    CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                    setTitle("Unduhan Toserba Lokal")
                    setDescription("Mengunduh file dari server toko")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                    )
                }
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this@MainActivity, "Unduhan dimulai.", Toast.LENGTH_SHORT).show()
            })
        }
        root.addView(webView, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f,
        ))
        setContentView(root)
        webView.loadUrl(serverBaseUrl)
    }

    private fun isTrustedServerUrl(uri: Uri): Boolean {
        val server = Uri.parse(serverBaseUrl)
        return isSafeServerUrl(uri)
            && uri.scheme == server.scheme
            && uri.host.equals(server.host, ignoreCase = true)
            && effectivePort(uri) == effectivePort(server)
    }

    private fun isSafeServerUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        if (host.isNullOrBlank() || !uri.userInfo.isNullOrBlank()) return false
        if (uri.fragment != null) return false
        if (scheme == "https") return true
        return scheme == "http" && isLoopbackHost(host)
    }

    private fun isLoopbackHost(host: String): Boolean {
        val normalized = host.lowercase().trim('[', ']')
        return normalized == "localhost" ||
            normalized == "127.0.0.1" ||
            normalized == "::1"
    }

    private fun effectivePort(uri: Uri): Int = when {
        uri.port != -1 -> uri.port
        uri.scheme == "https" -> 443
        else -> 80
    }

    private fun showServerDialog() {
        val serverInput = EditText(this).apply {
            setSingleLine(true)
            textSize = 15f
            setText(serverBaseUrl)
            hint = "https://ALAMAT-IP-KOMPUTER:3000"
        }
        val padding = dp(20)
        val container = LinearLayout(this).apply {
            setPadding(padding, dp(8), padding, 0)
            addView(serverInput)
        }
        AlertDialog.Builder(this)
            .setTitle("Alamat server toko")
            .setMessage("Masukkan alamat server yang dapat diakses melalui Wi-Fi toko.")
            .setView(container)
            .setNegativeButton("Batal", null)
            .setPositiveButton("Hubungkan") { _, _ ->
                val value = serverInput.text.toString().trim().trimEnd('/')
                val uri = runCatching { Uri.parse(value) }.getOrNull()
                if (uri == null || !isSafeServerUrl(uri)) {
                    Toast.makeText(
                        this,
                        "Gunakan HTTPS untuk server LAN. HTTP hanya boleh untuk localhost/127.0.0.1.",
                        Toast.LENGTH_LONG,
                    ).show()
                    return@setPositiveButton
                }
                serverBaseUrl = value
                getPreferences(Context.MODE_PRIVATE).edit().putString(SERVER_URL_KEY, value).apply()
                webView.loadUrl(serverBaseUrl)
            }
            .show()
    }

    private fun toolbarButton(text: String, onClick: () -> Unit): Button =
        Button(this).apply {
            this.text = text
            textSize = 11f
            isAllCaps = false
            minHeight = dp(42)
            minWidth = 0
            setPadding(dp(8), 0, dp(8), 0)
            setTextColor(GREEN)
            setOnClickListener { onClick() }
        }

    private fun beginBarcodeScan(mode: String) {
        if (mode !in listOf("pos", "product")) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingScanMode = mode
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), CAMERA_PERMISSION_REQUEST)
            return
        }
        pendingScanMode = ""
        synchronized(barcodeLock) { lastBarcode = "" }
        scannerHandler.removeCallbacks(clearBarcodeLock)
        val scanner = DecoratedBarcodeView(this)
        scanner.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult?) {
                val code = result?.text?.trim().orEmpty()
                if (code.isBlank()) return
                synchronized(barcodeLock) {
                    if (code == lastBarcode) return
                    lastBarcode = code
                    scannerHandler.removeCallbacks(clearBarcodeLock)
                    scannerHandler.postDelayed(clearBarcodeLock, BARCODE_ABSENCE_DELAY_MS)
                }
                runOnUiThread {
                    webView.evaluateJavascript(
                        "window.onToserbaBarcodeScanned(${JSONObject.quote(code)}, ${JSONObject.quote(mode)})",
                        null,
                    )
                    if (mode == "product") scannerDialog?.dismiss()
                }
            }

            override fun possibleResultPoints(resultPoints: MutableList<ResultPoint>?) {
                if (resultPoints.isNullOrEmpty()) return
                synchronized(barcodeLock) {
                    if (lastBarcode.isBlank()) return
                    scannerHandler.removeCallbacks(clearBarcodeLock)
                    scannerHandler.postDelayed(clearBarcodeLock, BARCODE_ABSENCE_DELAY_MS)
                }
            }
        })

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(12), dp(18), dp(12))
        }
        content.addView(TextView(this).apply {
            text = if (mode == "pos") "Scan barang ke keranjang" else "Scan barcode produk"
            textSize = 18f
            setTextColor(TEXT_COLOR)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, dp(8))
        })
        content.addView(TextView(this).apply {
            text = if (mode == "pos") "Arahkan barcode ke kamera. Setiap scan menambah satu barang." else "Arahkan kamera ke barcode pada kemasan."
            textSize = 13f
            setTextColor(MUTED_COLOR)
            setPadding(0, 0, 0, dp(12))
        })
        content.addView(scanner, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(300),
        ))
        content.addView(toolbarButton("Selesai") { scannerDialog?.dismiss() })
        scannerDialog = AlertDialog.Builder(this)
            .setView(content)
            .create()
            .also { dialog ->
                dialog.setOnDismissListener {
                    scannerHandler.removeCallbacks(clearBarcodeLock)
                    synchronized(barcodeLock) { lastBarcode = "" }
                    scanner.pause()
                    barcodeView = null
                }
                dialog.show()
                dialog.window?.setLayout(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
                barcodeView = scanner
                scanner.resume()
            }
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun scanBarcode(mode: String) {
            runOnUiThread { beginBarcodeScan(mode) }
        }

        @JavascriptInterface
        fun printReceipt() {
            runOnUiThread {
                try {
                    val manager = getSystemService(Context.PRINT_SERVICE) as PrintManager
                    manager.print(
                        "Struk-Toserba",
                        webView.createPrintDocumentAdapter("Struk-Toserba"),
                        PrintAttributes.Builder().build(),
                    )
                } catch (error: Exception) {
                    Toast.makeText(
                        this@MainActivity,
                        "Tidak dapat membuka pratinjau cetak: ${error.message ?: "terjadi kesalahan"}",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED && pendingScanMode.isNotBlank()) {
                beginBarcodeScan(pendingScanMode)
            } else {
                pendingScanMode = ""
                Toast.makeText(this, "Izinkan akses kamera untuk memindai barcode.", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        barcodeView?.resume()
    }

    override fun onPause() {
        barcodeView?.pause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val CAMERA_PERMISSION_REQUEST = 701
        private const val BARCODE_ABSENCE_DELAY_MS = 1200L
        private const val SERVER_URL_KEY = "server_url"
        private const val DEFAULT_SERVER_URL = "http://127.0.0.1:3000"
        private val GREEN = Color.rgb(35, 93, 61)
        private val PAGE_COLOR = Color.rgb(246, 247, 244)
        private val TEXT_COLOR = Color.rgb(48, 61, 52)
        private val MUTED_COLOR = Color.rgb(117, 130, 120)
    }
}
