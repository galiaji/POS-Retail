# Toserba Lokal Android

Aplikasi Android menampilkan seluruh aplikasi Toserba Lokal dengan antarmuka responsif: Ringkasan, POS, Inventori, penerimaan barang, opname stok, Akunting, pengeluaran, serta Pengguna & aktivitas. Menu dan tindakan mengikuti peran akun yang masuk, sama seperti versi web. Pemindaian barcode POS dan Inventori memakai kamera Android. Struk transaksi memiliki tampilan khusus dan dapat dibuka melalui pratinjau cetak Android. Data tetap tersimpan pada server/database toko.

## Membuat APK

1. Pasang Android Studio versi stabil beserta Android SDK Platform 35.
2. Dari folder `android`, jalankan `.\gradlew.bat assembleDebug`. Gradle 8.9 dan dependensi proyek akan diunduh saat pertama kali dijalankan.
3. Atau, buka folder `android` sebagai proyek di Android Studio dan pilih **Build > Build App Bundle(s) / APK(s) > Build APK(s)**.
4. APK debug tersedia di `android/app/build/outputs/apk/debug/app-debug.apk`. Pindahkan ke HP dan izinkan pemasangan aplikasi dari sumber tersebut.

## Menghubungkan ke server

- Jalankan server Toserba dan pastikan HP berada di jaringan lokal yang sama.
- Untuk pengiriman APK, salin file melalui kabel/berkas aman atau gunakan URL HTTPS tepercaya. Jangan gunakan HTTP pada alamat LAN untuk mengirim aplikasi atau mengakses POS.
- Aplikasi memakai `http://127.0.0.1:3000` sebagai alamat awal untuk pengembangan loopback. Pada perangkat fisik, gunakan tombol **Server** dan masukkan URL `https://ALAMAT-IP-KOMPUTER:3000` beserta port yang benar.
- Masuk memakai akun kasir, manajer, atau pemilik yang sudah terdaftar di web.
- Untuk HTTPS lokal dengan sertifikat `mkcert`, salin **hanya** `rootCA.pem` ke HP dan pasang melalui pengaturan Android sebagai CA certificate tepercaya. Jangan pernah salin atau bagikan `rootCA-key.pem`.
- Aplikasi meminta izin kamera saat pertama kali tombol scan ditekan. Di POS, arahkan barcode satu per satu untuk menambahkannya langsung ke keranjang. Di Inventori, scan menambahkan kode pada daftar barcode/SKU produk; masukkan kode satu per baris. Beberapa kode pada produk yang sama menggunakan stok dan harga yang sama.

Konfigurasi jaringan Android menolak cleartext secara bawaan dan hanya memperbolehkan HTTP untuk `localhost`/`127.0.0.1`. HTTPS menerima sertifikat sistem atau CA tepercaya yang dipasang pengguna agar sertifikat lokal toko dapat diverifikasi; jangan memasang atau mempercayai CA yang tidak dikenal. Gunakan HTTPS untuk seluruh akses LAN.

Batasi jaringan toko dengan firewall, segmentasi Wi-Fi/VLAN, atau VPN privat, dan jangan membuka server ke internet. Gunakan PIN akun yang panjang, cadangkan `data/toserba.sqlite` secara rutin ke lokasi aman, dan uji pemulihan cadangan. Pengaturan ini mengurangi risiko konfigurasi namun tidak menjamin keamanan absolut.

## Batasan

APK perlu dibangun dan ditandatangani untuk distribusi produksi sebelum dibagikan luas. Versi awal ini adalah kasir online-LAN: transaksi dikirim ke server saat itu juga, tidak menyediakan antrean penjualan offline ketika server/jaringan toko terputus.
