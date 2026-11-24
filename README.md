# Toserba Lokal

Aplikasi web responsif untuk operasional toserba. Server lokal dan database SQLite berjalan di komputer toko; perangkat kasir/manajer dapat mengakses data bersama melalui Wi-Fi/LAN. POS dan transaksi tetap dapat diproses ketika internet terputus selama komputer server dan jaringan lokal toko tetap tersedia. Tidak ada layanan cloud.

## Menjalankan aplikasi

1. Pasang Node.js 22.5 atau lebih baru pada komputer toko.
2. Dari folder proyek, jalankan `npm install` sekali untuk memasang decoder barcode lokal.
3. Jalankan `npm start`.
4. Secara bawaan server hanya mengikat `127.0.0.1`/localhost dan tidak dapat diakses dari HP lain. Untuk penggunaan LAN, aktifkan sertifikat TLS seperti di bawah; sertifikat yang sudah dikonfigurasi mengizinkan server mengikat antarmuka LAN. Jika Windows Firewall meminta izin, izinkan hanya jaringan privat toko.
5. Pada pembukaan pertama, buat nama pengguna pemilik dan PIN 6–12 angka. Pemilik kemudian dapat membuat akun manajer dan kasir dengan PIN masing-masing.

Database disimpan pada `data/toserba.sqlite`. Hentikan server dengan `Ctrl+C`; simpan salinan file database secara berkala sebagai cadangan. Jangan hapus file database saat aplikasi sedang berjalan. Saat versi baru menambahkan struktur cabang/lokasi, server memigrasikan database lama secara otomatis dan menempatkan stok serta riwayat yang ada pada cabang/lokasi default.

### Mengaktifkan HTTPS untuk kamera HP

Browser hanya mengizinkan kamera pada HTTPS tepercaya atau `localhost`. HTTPS server ini diperlukan untuk penggunaan multi-perangkat/LAN. Tanpa sertifikat, aplikasi sengaja tetap berjalan sebagai HTTP loopback saja dan tidak membagikan POS atau sesi ke LAN. Untuk jaringan lokal, gunakan sertifikat yang memuat alamat IP server dan pasang CA penerbitnya sebagai sertifikat tepercaya di setiap HP yang akan memakai kamera.

Contoh memakai `mkcert` pada Windows PowerShell (ganti alamat IP dengan alamat server yang dicetak aplikasi; sebaiknya buat reservasi DHCP agar IP tidak berubah):

```powershell
mkcert -install
New-Item -ItemType Directory -Force "$env:USERPROFILE\.toserba-certs"
mkcert -cert-file "$env:USERPROFILE\.toserba-certs\lan.pem" -key-file "$env:USERPROFILE\.toserba-certs\lan-key.pem" 192.168.18.182 localhost 127.0.0.1
$env:TLS_CERT_FILE = "$env:USERPROFILE\.toserba-certs\lan.pem"
$env:TLS_KEY_FILE = "$env:USERPROFILE\.toserba-certs\lan-key.pem"
npm start
```

Server akan mencetak alamat `https://...` setelah dimulai. Impor `rootCA.pem` dari direktori yang ditunjukkan perintah `mkcert -CAROOT` ke pengaturan sertifikat tepercaya pada HP, lalu buka alamat HTTPS tersebut. Jangan salin atau bagikan file private key `rootCA-key.pem`; simpan file sertifikat server dan private key di luar folder proyek. `TLS_CERT_FILE` dan `TLS_KEY_FILE` harus diatur setiap kali server dimulai dari terminal baru. Jika salah satu variabel tidak diatur atau keduanya tidak ada, server memakai HTTP loopback dan menolak penyebaran LAN.

### Keamanan operasi toko

- Gunakan HTTPS dengan sertifikat tepercaya untuk server LAN. Jangan mempercayai sertifikat/pengguna CA yang tidak dikenal; Android hanya menerima HTTP untuk `localhost` dan alamat loopback.
- Batasi server ke jaringan privat toko dengan firewall, segmentasi Wi-Fi/VLAN, atau VPN privat. Jangan mem-forward port server ke internet atau terhubung ke Wi-Fi publik untuk operasi POS.
- Gunakan PIN pemilik dan akun staf yang panjang (minimum 6, sebaiknya lebih panjang), lakukan rotasi bila diperlukan, dan batasi fisik/perangkat yang dapat mengakses server.
- Cadangkan `data/toserba.sqlite` secara berkala saat server berhenti atau gunakan prosedur cadangan yang aman; simpan cadangan terenkripsi dan uji pemulihannya.
- Pengaturan ini mengurangi paparan yang jelas, tetapi tidak menjamin keamanan sempurna: tetap kelola pembaruan Node.js/Android, perangkat, sertifikat, akses Wi-Fi, dan cadangan secara rutin.

## Fondasi yang tersedia

- Ringkasan omzet dan jumlah transaksi harian, jumlah produk, stok menipis, dan transaksi terbaru.
- POS dengan pencarian barang, keranjang, beberapa metode pembayaran, validasi stok per lokasi pada server, dan struk yang bisa dicetak. Produk dapat memiliki diskon persentase atau promo beli X gratis Y dengan masa berlaku opsional; bila keduanya aktif, sistem memilih diskon total terbesar tanpa menumpuknya. Harga akhir, jumlah diskon, dan jenis promo disimpan per barang pada transaksi dan ditampilkan di nota; stok tetap berkurang untuk seluruh barang termasuk unit gratis. Poin member dihitung dari total setelah diskon, yaitu 1 poin per Rp10.000 (dibulatkan ke bawah). Transaksi dapat ditandai sebagai pelanggan biasa atau member; member dicari dengan nomor HP dan identitasnya tercatat pada nota serta riwayat. Menu **Member** untuk pemilik dan manajer dapat mendaftarkan member tanpa transaksi, mencari daftar berdasarkan nama/nomor HP, dan melihat saldo poin; kasir tetap dapat mencari/mendaftarkan member saat transaksi. Riwayat transaksi dapat dicari berdasarkan nomor nota, nama/nomor HP member, nama/kode barang, atau metode pembayaran dan difilter menurut tanggal; nota lama dapat dibuka kembali dan dicetak dari riwayat.
- Kasir harus dibuka dan ditutup secara manual per lokasi. Pemilik, manajer, dan kasir dapat mengelola sesi; modal awal dan uang akhir bersifat opsional, ringkasan penjualan disimpan saat penutupan, dan server menolak transaksi selama kasir tutup.
- Pemilih dan pembuatan cabang serta lokasi stok (toko, gudang, atau rak); stok inventori, penerimaan barang, dan penjualan dipisahkan per lokasi/cabang.
- Satu produk dapat memiliki beberapa kode barcode/SKU alternatif, dimasukkan satu per baris; semuanya menunjuk stok dan harga yang sama. Setiap kode wajib unik di katalog, tidak memiliki panjang minimum, dapat mencapai 1.000 karakter, dan disimpan sebagai teks agar nol di depannya tetap terjaga. Semua kode dapat dipakai untuk pencarian dan scan POS. Data lama yang memiliki SKU internal dan barcode berbeda dimigrasikan sebagai kode alternatif, dengan barcode sebagai kode utama; riwayat transaksi lama tetap dipertahankan. Di Inventori, tombol **Kamera** membaca barcode 1D/2D menggunakan decoder lokal ZXing; tombol **Scanner USB** mengisi daftar kode barang. Browser mensyaratkan HTTPS atau localhost untuk akses kamera; HP harus memakai HTTPS tepercaya untuk IP LAN atau scanner USB/Bluetooth.
- Opname stok di Inventori per cabang/lokasi: pilih barang yang telah dihitung, masukkan stok fisik, lalu simpan untuk memperbarui saldo dan mencatat riwayat stok sistem, stok hitung, serta selisihnya. Perubahan saldo dan riwayat disimpan dalam satu transaksi agar kegagalan tidak meninggalkan penyesuaian sebagian.
- Pencatatan supplier, nomor faktur, dan penerimaan barang (GRN) dasar yang menambah stok serta memperbarui estimasi modal rata-rata di lokasi penerima.
- Akunting dasar per cabang: omzet, modal barang terjual, pengeluaran operasional, estimasi laba, riwayat transaksi penjualan dengan pencarian dan akses ke detail nota, serta buku kas harian/bulanan.
- Multi-user dengan akun nama pengguna + PIN tersendiri, PIN di-hash, sesi cookie HttpOnly, dan pembatasan percobaan masuk. Hanya pemilik yang dapat berpindah dan membuat cabang. Manajer memiliki akses fitur operasional (dashboard, POS, inventori, pembelian, opname, dan akunting) tetapi terikat ke tepat satu cabang dan tidak dapat berpindah cabang atau mengelola akun. Kasir terikat ke tepat satu cabang dan hanya mengakses POS. Pemilik dapat mengelola staf dan menetapkan cabang masing-masing.
- Menu **Pengguna & aktivitas** khusus pemilik untuk membuat akun, mengubah nama/peran/PIN, menonaktifkan akun, mengatur cabang akses, dan melihat log aktivitas. Log menyimpan pengguna, waktu, cabang/lokasi, objek, serta nilai sebelum/sesudah untuk perubahan produk, pengguna, stok opname, penerimaan, penjualan, pengeluaran, cabang, lokasi, kategori, dan supplier. Log menampilkan hingga 200 aktivitas terakhir.

Produk, kategori, dan supplier adalah master data bersama. Setiap cabang/lokasi memiliki saldo stok, penerimaan, penjualan, opname, dan pengeluaran yang terpisah. Stok tidak digabung antar-cabang saat operasional; jumlah stok pada katalog produk merupakan total lintas lokasi, sedangkan tampilan Inventori dan POS mengikuti cabang/lokasi aktif. Semua kode barcode/SKU alternatif tetap unik di katalog bersama dan memakai saldo stok yang sama. Pemilik dapat berpindah ke semua cabang; akun manajer dan kasir langsung masuk ke satu-satunya cabang yang ditugaskan.

## Tahap pengembangan berikutnya

Fondasi ini belum mencakup sinkronisasi otomatis antardatabase/server, antrean offline di browser bila jaringan lokal terputus, transfer antar lokasi, PO/faktur-hutang supplier penuh, harga eceran/grosir/member, penukaran poin atau diskon member, promo, retur, jurnal akuntansi berpasangan, pajak, shift/SDM, atau pelaporan lanjutan. Server lokal tetap mengoperasikan POS ketika internet toko terputus, tetapi perangkat HP/desktop tetap memerlukan koneksi Wi-Fi/LAN ke server lokal.

Tahap yang disarankan: (1) transfer antar lokasi dan penelusuran kedaluwarsa/FIFO-FEFO; (2) PO dan proses hutang/pencocokan faktur; (3) retur, promo bertingkat/kombinasi, dan harga bertingkat; (4) shift/SDM dan penyempurnaan laporan audit; (5) jurnal, pajak, laporan lanjutan, kemudian sinkronisasi pusat/cloud dengan antrean dan resolusi konflik.

Kode sumber aplikasi kasir Android terpisah tersedia pada folder [`android`](./android). Aplikasi tersebut memakai server/database dan akun yang sama, serta mendukung scan kamera berulang. Build APK memerlukan Android Studio dan Android SDK; lihat [panduan aplikasi Android](./android/README.md).

## Batasan dan keamanan

Aplikasi ini ditujukan untuk pemakaian di jaringan lokal toko, bukan untuk dibuka langsung ke internet. Sinkronisasi antar-server/cabang belum ada. Aktivitas akun baru tercatat setelah pembaruan versi ini; tidak ada riwayat pengguna untuk perubahan lama sebelum migrasi. Pengguna dan PIN lama dimigrasikan menjadi akun pemilik `pemilik` dengan PIN lama tetap berlaku; segera ubah nama pengguna atau PIN jika diperlukan dan buat akun terpisah untuk staf. Log aktivitas saat ini menampilkan 200 catatan terakhir dan belum memiliki ekspor/retensi khusus. Gunakan jaringan Wi-Fi tepercaya, ubah/kelola akses jaringan dari router, dan cadangkan database secara rutin. Laporan laba adalah estimasi sebelum pajak dan penyesuaian akuntansi; fitur ini belum menggantikan sistem pembukuan atau faktur pajak lengkap.

## Pengujian

Jalankan `npm test` untuk menguji autentikasi, multi-user, pembatasan cabang tunggal untuk manajer/kasir, hak akses peran, log perubahan, migrasi database, pencarian barcode, opname dan riwayat penyesuaian stok, sesi buka/tutup kasir, transaksi, serta perhitungan akunting.
