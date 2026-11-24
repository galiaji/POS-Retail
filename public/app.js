const money = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});
const shortDate = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });
const state = {
  products: [],
  cart: new Map(),
  period: "month",
  storeId: Number(localStorage.getItem("toserba.storeId")) || 1,
  locationId: null,
  stores: [],
  locations: [],
  stocktakeProducts: [],
  stocktakeCounts: new Map(),
  currentUser: null,
  userStores: [],
  register: { isOpen: false, session: null, summary: null },
  toastTimer: null,
  cameraControls: null,
  barcodeReader: null,
  cameraMode: "product",
  cameraLastCode: "",
  cameraNoCodeTimer: null,
  scanAudioContext: null,
  memberLookup: null,
};
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.storeId ? { "X-Store-Id": String(state.storeId) } : {}),
      ...(state.locationId ? { "X-Location-Id": String(state.locationId) } : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (response.status === 401 && path !== "/api/login") {
    showGate(false);
    throw new Error(result.error || "Silakan masuk kembali.");
  }
  if (!response.ok) throw new Error(result.error || "Permintaan tidak berhasil.");
  return result;
}

function showGate(setupRequired) {
  $("#gate").classList.remove("hidden");
  $("#app").classList.add("hidden");
  $("#gate-title").textContent = setupRequired ? "Atur PIN pemilik" : "Selamat datang";
  $("#gate-copy").textContent = setupRequired
    ? "Buat PIN 6–12 angka untuk melindungi data toko."
    : "Masuk untuk mengelola operasional toserba.";
  $("#pin-label").textContent = setupRequired ? "Buat PIN baru" : "PIN";
  $("#pin-input").autocomplete = setupRequired ? "new-password" : "current-password";
  $("#gate-submit").textContent = setupRequired ? "Buat PIN & masuk" : "Masuk";
  $("#gate-error").textContent = "";
  $("#gate-form").dataset.setup = String(setupRequired);
  $("#pin-input").value = "";
}

async function initialize() {
  const session = await request("/api/session");
  if (!session.authenticated || !session.user) {
    showGate(session.setupRequired);
    return;
  }
  state.currentUser = session.user;
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  configureRoleInterface();
  $("#current-date").textContent = new Intl.DateTimeFormat("id-ID", { dateStyle: "full" }).format(new Date());
  $("#pos-date").textContent = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date());
  await loadStoreContext();
  switchView(state.currentUser.role === "cashier" ? "pos" : "dashboard");
}

function configureRoleInterface() {
  const { role, displayName } = state.currentUser;
  const owner = role === "owner";
  $$(".owner-only").forEach((element) => element.classList.toggle("hidden", !owner));
  $$(".management-only").forEach((element) => element.classList.toggle("hidden", role === "cashier"));
  $("#add-store-button").classList.toggle("hidden", !owner);
  $("#store-picker").classList.toggle("hidden", !owner);
  $("#add-location-button").classList.toggle("hidden", role === "cashier");
  $("#current-user").textContent = `${displayName} · ${role === "owner" ? "Pemilik" : role === "manager" ? "Manajer" : "Kasir"}`;
  $("#user-avatar").textContent = displayName.slice(0, 1).toLocaleUpperCase();
}

async function loadStoreContext(preferredStoreId) {
  state.stores = await request("/api/stores");
  if (!state.stores.length) throw new Error("Belum ada cabang aktif.");
  const savedStoreId = preferredStoreId || state.storeId;
  const selectedStore = state.stores.find((store) => store.id === savedStoreId) || state.stores[0];
  state.storeId = selectedStore.id;
  localStorage.setItem("toserba.storeId", String(state.storeId));
  $("#store-select").innerHTML = state.stores.map((store) =>
    `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join("");
  $("#store-select").value = String(state.storeId);
  state.locations = await request("/api/locations", {
    headers: { "X-Store-Id": String(state.storeId), "X-Location-Id": "" },
  });
  if (!state.locations.length) throw new Error("Cabang ini belum memiliki lokasi stok.");
  const locationKey = `toserba.locationId.${state.storeId}`;
  const savedLocationId = Number(localStorage.getItem(locationKey));
  const selectedLocation = state.locations.find((location) => location.id === savedLocationId) || state.locations[0];
  state.locationId = selectedLocation.id;
  localStorage.setItem(locationKey, String(state.locationId));
  $("#location-select").innerHTML = state.locations.map((location) =>
    `<option value="${location.id}">${escapeHtml(location.name)}</option>`).join("");
  $("#location-select").value = String(state.locationId);
  await loadRegisterStatus();
}

async function loadRegisterStatus() {
  state.register = await request("/api/register");
  const isOpen = state.register.isOpen;
  $("#register-status").textContent = isOpen ? `Kasir buka · ${state.register.session.openedByName}` : "Kasir tutup";
  $("#register-status").classList.toggle("open", isOpen);
  $("#register-status").classList.toggle("closed", !isOpen);
  $("#register-toggle-button").textContent = isOpen ? "Tutup kasir" : "Buka kasir";
  $("#register-toggle-button").classList.toggle("primary", !isOpen);
  $("#register-toggle-button").classList.toggle("secondary", isOpen);
  $("#pos-register-notice").classList.toggle("closed", !isOpen);
  $("#pos-register-notice").classList.toggle("open", isOpen);
  $("#pos-register-notice").textContent = isOpen
    ? `Kasir dibuka oleh ${state.register.session.openedByName} pada ${shortDate.format(new Date(state.register.session.openedAt))}.`
    : "Kasir sedang ditutup. Buka kasir untuk mulai membuat transaksi.";
  $("#checkout-button").disabled = !isOpen || state.cart.size === 0;
  return state.register;
}

async function refreshCurrentView() {
  const activeView = $(".view.active")?.id.replace("view-", "") || "dashboard";
  if (activeView === "dashboard") await loadDashboard();
  if (activeView === "pos") {
    await loadProducts($("#pos-search").value);
    await loadSalesHistory();
  }
  if (activeView === "inventory") await loadInventory();
  if (activeView === "members") await loadMembers();
  if (activeView === "accounting") await loadAccounting();
  if (activeView === "users") await loadUserManagement();
  await loadRegisterStatus();
}

async function loadDashboard() {
  const data = await request("/api/dashboard");
  $("#stat-sales").textContent = money.format(data.today_sales);
  $("#stat-transactions").textContent = data.today_transactions.toLocaleString("id-ID");
  $("#stat-products").textContent = data.product_count.toLocaleString("id-ID");
  $("#stat-low-stock").textContent = data.low_stock_count.toLocaleString("id-ID");
  $("#recent-sales").innerHTML = data.recentSales.length
    ? `<div class="recent-sales-list">${data.recentSales.map((sale) => `
      <article class="recent-sale-card">
        <div class="recent-sale-heading"><strong>${escapeHtml(sale.receipt_number)}</strong><span>${escapeHtml(shortDate.format(new Date(sale.created_at)))}</span></div>
        <div class="recent-sale-details"><span>${escapeHtml(sale.payment_method)}</span><strong>${money.format(sale.total)}</strong></div>
        <button class="action-button" data-sale-detail="${sale.id}">Lihat detail nota</button>
      </article>`).join("")}</div>`
    : '<div class="empty-state">Belum ada transaksi. Transaksi pertama Anda akan muncul di sini.</div>';
}

async function loadSalesHistory() {
  const params = new URLSearchParams();
  const search = $("#transaction-search").value.trim();
  const from = $("#transaction-date-from").value;
  const to = $("#transaction-date-to").value;
  if (search) params.set("q", search);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const sales = await request(`/api/sales?${params}`);
  $("#transaction-history").innerHTML = sales.length
    ? `<table><thead><tr><th>NO. NOTA</th><th>TANGGAL</th><th>PELANGGAN</th><th>JENIS BARANG</th><th>PEMBAYARAN</th><th>TOTAL</th><th></th></tr></thead><tbody>${sales.map((sale) => `
      <tr><td><strong>${escapeHtml(sale.receiptNumber)}</strong></td>
      <td>${escapeHtml(shortDate.format(new Date(sale.createdAt)))}</td>
      <td>${sale.customerType === "member" ? `Member · ${escapeHtml(sale.memberName)}` : "Biasa"}</td><td>${sale.itemCount}</td>
      <td>${escapeHtml(sale.paymentMethod)}</td><td class="amount-cell">${money.format(sale.total)}</td>
      <td><button class="action-button" data-sale-detail="${sale.id}">Lihat nota</button></td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Tidak ada transaksi yang cocok dengan pencarian.</div>';
}

function switchView(name) {
  const allowedViews = state.currentUser?.role === "cashier"
    ? new Set(["pos"])
    : state.currentUser?.role === "manager"
      ? new Set(["dashboard", "pos", "inventory", "members", "accounting"])
      : new Set(["dashboard", "pos", "inventory", "members", "accounting", "users"]);
  if (!allowedViews.has(name)) return;
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $$(".nav-link").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  if (name === "dashboard") loadDashboard().catch(showError);
  if (name === "pos") {
    loadProducts($("#pos-search").value).catch(showError);
    loadSalesHistory().catch(showError);
  }
  if (name === "inventory") loadInventory().catch(showError);
  if (name === "members") loadMembers().catch(showError);
  if (name === "accounting") loadAccounting().catch(showError);
  if (name === "users") loadUserManagement().catch(showError);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function showError(error) {
  if (error instanceof Error) notify(error.message);
}

function productCodesOf(product) {
  return product.productCodes?.length
    ? product.productCodes
    : [product.productCode || product.barcode || product.sku].filter(Boolean);
}

function appendProductCode(code) {
  const field = $("#product-form").elements.productCodes;
  const codes = field.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!codes.some((value) => value.toLocaleLowerCase() === code.toLocaleLowerCase())) codes.push(code);
  field.value = codes.join("\n");
}

function productPromotion(product, quantity) {
  if (!product.promoActive) return { discountAmount: 0, discountLabel: "" };
  const discountPerUnit = Math.floor(product.sellingPrice / 100) * product.promoDiscountPercent
    + Math.floor((product.sellingPrice % 100) * product.promoDiscountPercent / 100);
  const percentDiscount = discountPerUnit * quantity;
  const freeQuantity = product.promoBuyQuantity > 0
    ? Math.floor(quantity / (product.promoBuyQuantity + product.promoFreeQuantity)) * product.promoFreeQuantity
    : 0;
  const quantityDiscount = product.sellingPrice * freeQuantity;
  if (percentDiscount >= quantityDiscount && percentDiscount > 0) {
    return { discountAmount: percentDiscount, discountLabel: `Diskon produk ${product.promoDiscountPercent}%` };
  }
  if (quantityDiscount > 0) {
    return {
      discountAmount: quantityDiscount,
      discountLabel: `Beli ${product.promoBuyQuantity} gratis ${product.promoFreeQuantity}`,
    };
  }
  return { discountAmount: 0, discountLabel: "" };
}

function productPromotionLabels(product) {
  return [
    product.promoDiscountPercent > 0 ? `Diskon ${product.promoDiscountPercent}%` : "",
    product.promoBuyQuantity > 0 ? `Beli ${product.promoBuyQuantity} gratis ${product.promoFreeQuantity}` : "",
  ].filter(Boolean);
}

async function loadProducts(search = "") {
  state.products = await request(`/api/products?q=${encodeURIComponent(search)}`);
  $("#pos-products").innerHTML = state.products.length
    ? state.products.map((product) => {
      const promoLabels = product.promoActive ? productPromotionLabels(product) : [];
      const singleUnitPromo = productPromotion(product, 1);
      const price = singleUnitPromo.discountAmount
        ? `<span class="product-promo-price"><del>${money.format(product.sellingPrice)}</del> ${money.format(product.sellingPrice - singleUnitPromo.discountAmount)}</span>`
        : `<span>${money.format(product.sellingPrice)}</span>`;
      return `
        <button class="product-tile" data-add-product="${product.id}" ${product.stock === 0 ? "disabled" : ""}>
          <strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.productCode || product.sku)} · Stok ${product.stock}</small>
          ${promoLabels.length ? `<small class="product-promo-label">${promoLabels.map(escapeHtml).join(" · ")}</small>` : ""}
          ${price}
        </button>`;
    }).join("")
    : '<div class="empty-state">Belum ada barang yang cocok. Tambahkan barang melalui menu Inventori.</div>';
  renderCart();
}

function addToCart(product) {
  if (product.stock === 0) {
    notify(`Stok ${product.name} habis.`);
    return false;
  }
  const cartItem = state.cart.get(product.id);
  if (cartItem && cartItem.quantity >= product.stock) {
    notify(`Stok ${product.name} hanya ${product.stock}.`);
    return false;
  }
  state.cart.set(product.id, { ...product, quantity: (cartItem?.quantity || 0) + 1 });
  renderCart();
  return true;
}

function prepareScanAudio() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) return;
  try {
    state.scanAudioContext ||= new AudioContextConstructor();
    if (state.scanAudioContext.state === "suspended") {
      state.scanAudioContext.resume().catch(showError);
    }
  } catch (error) {
    showError(error);
  }
}

function playScanSuccessSound() {
  const audioContext = state.scanAudioContext;
  if (!audioContext || audioContext.state !== "running") return;
  const startTime = audioContext.currentTime;
  [[1046, 0], [1318, 0.16]].forEach(([frequency, offset]) => {
    const oscillator = audioContext.createOscillator();
    const volume = audioContext.createGain();
    const toneStart = startTime + offset;
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(frequency, toneStart);
    volume.gain.setValueAtTime(0.0001, toneStart);
    volume.gain.exponentialRampToValueAtTime(0.35, toneStart + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.12);
    oscillator.connect(volume);
    volume.connect(audioContext.destination);
    oscillator.start(toneStart);
    oscillator.stop(toneStart + 0.12);
  });
}

async function addPosScannedCode(code, { fromScanner = false } = {}) {
  const normalizedCode = code.trim();
  if (!normalizedCode) return;
  const matches = await request(`/api/products?q=${encodeURIComponent(normalizedCode)}`);
  const exactMatches = matches.filter((product) => productCodesOf(product)
    .some((productCode) => productCode.toLocaleLowerCase() === normalizedCode.toLocaleLowerCase()));
  const uniqueMatches = [...new Map(exactMatches.map((product) => [product.id, product])).values()];
  if (uniqueMatches.length !== 1) {
    const message = uniqueMatches.length
      ? "Barcode ini cocok dengan lebih dari satu barang. Periksa data barcode di Inventori."
      : `Barcode "${normalizedCode}" tidak ditemukan.`;
    $("#pos-scan-status").textContent = message;
    if (state.cameraMode !== "pos") notify(message);
    return;
  }
  const product = uniqueMatches[0];
  if (addToCart(product)) {
    const item = state.cart.get(product.id);
    $("#pos-scan-status").textContent = `${product.name} ditambahkan · jumlah di keranjang: ${item.quantity}. Siap scan berikutnya.`;
    if (fromScanner) playScanSuccessSound();
  } else {
    $("#pos-scan-status").textContent = product.stock === 0
      ? `Stok ${product.name} habis, tidak ditambahkan ke keranjang.`
      : `Stok ${product.name} hanya ${product.stock}, jumlah maksimum sudah di keranjang.`;
  }
}

window.onToserbaBarcodeScanned = (code, mode) => {
  if (mode === "pos") {
    addPosScannedCode(code, { fromScanner: true }).catch((error) => {
      $("#pos-scan-status").textContent = error.message;
      showError(error);
    });
    return;
  }
  if (mode === "product") {
    appendProductCode(code);
    $("#barcode-camera-status").textContent = `Barcode ${code} berhasil dibaca.`;
    notify("Barcode berhasil diisi.");
  }
};

async function scanPosProduct() {
  const input = $("#pos-scan-input");
  const code = input.value.trim();
  if (!code) return;
  input.value = "";
  try {
    await addPosScannedCode(code);
  } catch (error) {
    $("#pos-scan-status").textContent = error.message;
    showError(error);
  } finally {
    input.focus();
  }
}

function renderCart() {
  const items = [...state.cart.values()];
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + item.sellingPrice * item.quantity, 0);
  const discountTotal = items.reduce((sum, item) => sum + productPromotion(item, item.quantity).discountAmount, 0);
  $("#cart-count").textContent = `${count} barang`;
  $("#cart-subtotal").textContent = money.format(subtotal);
  $("#cart-discount").textContent = `−${money.format(discountTotal)}`;
  $("#cart-discount-row").classList.toggle("hidden", discountTotal === 0);
  $("#cart-total").textContent = money.format(subtotal - discountTotal);
  $("#checkout-button").disabled = !state.register.isOpen || items.length === 0;
  $("#cart-items").innerHTML = items.length
    ? items.map((item) => {
      const promotion = productPromotion(item, item.quantity);
      return `
        <div class="cart-line"><div class="cart-line-info"><strong>${escapeHtml(item.name)}</strong><small>${money.format(item.sellingPrice)} / item</small>
        ${promotion.discountAmount ? `<small class="cart-line-promo">${escapeHtml(promotion.discountLabel)} · hemat ${money.format(promotion.discountAmount)}</small>` : ""}</div>
        <div class="cart-line-controls"><button class="quantity-button" data-cart-action="decrease" data-product-id="${item.id}" aria-label="Kurangi">−</button>
        <span class="quantity-value">${item.quantity}</span><button class="quantity-button" data-cart-action="increase" data-product-id="${item.id}" aria-label="Tambah">+</button></div></div>`;
    }).join("")
    : '<div class="empty-state">Keranjang masih kosong.</div>';
}

async function loadInventory() {
  const [products, receipts] = await Promise.all([
    request(`/api/products?q=${encodeURIComponent($("#inventory-search").value)}`),
    request("/api/receipts"),
  ]);
  state.products = products;
  $("#inventory-count").textContent = `${products.length} barang`;
  $("#inventory-table").innerHTML = products.length
    ? `<table><thead><tr><th>BARANG</th><th>BARCODE / SKU</th><th>KATEGORI</th><th>HARGA JUAL</th><th>HARGA MODAL</th><th>STOK</th><th>AKSI</th></tr></thead><tbody>${products.map((product) => `
      <tr><td><strong>${escapeHtml(product.name)}</strong></td><td>${productCodesOf(product).map(escapeHtml).join("<br>")}</td><td>${escapeHtml(product.category)}</td>
      <td>${money.format(product.sellingPrice)}${productPromotionLabels(product).length ? `<small class="inventory-promo">${productPromotionLabels(product).map(escapeHtml).join(" · ")}${product.promoStartDate ? `<br>${escapeHtml(product.promoStartDate)} – ${escapeHtml(product.promoEndDate)}` : ""}<br>${product.promoActive ? "Aktif" : "Tidak aktif hari ini"}</small>` : ""}</td><td>${money.format(product.costPrice)}</td>
      <td><span class="stock-badge ${product.stock <= product.minStock ? "low" : "ok"}">${product.stock} ${product.stock <= product.minStock ? "· Menipis" : ""}</span></td>
      <td><button class="action-button" data-edit-product="${product.id}">Edit</button> <button class="action-button" data-archive-product="${product.id}">Arsip</button></td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada barang. Tambahkan barang pertama untuk mulai berjualan.</div>';
  const stocktakes = await request("/api/stocktakes");
  $("#stocktake-history").innerHTML = stocktakes.length
    ? `<table><thead><tr><th>TANGGAL</th><th>REFERENSI</th><th>BARANG DIHITUNG</th><th>BARANG DISESUAIKAN</th><th>TOTAL SELISIH UNIT</th><th>AKSI</th></tr></thead><tbody>${stocktakes.map((stocktake) => `
      <tr><td>${escapeHtml(shortDate.format(new Date(stocktake.createdAt)))}</td><td><strong>${escapeHtml(stocktake.reference)}</strong></td>
      <td>${stocktake.itemCount}</td><td>${stocktake.changedCount}</td><td>${stocktake.adjustmentUnits}</td>
      <td><button class="action-button" data-stocktake-detail="${stocktake.id}">Rincian</button></td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada opname stok di lokasi ini.</div>';
  $("#receipt-history").innerHTML = receipts.length
    ? `<table><thead><tr><th>TANGGAL</th><th>NO. PENERIMAAN</th><th>SUPPLIER</th><th>BARANG</th><th>LOKASI</th><th>TOTAL</th></tr></thead><tbody>${receipts.map((receipt) => `
      <tr><td>${escapeHtml(shortDate.format(new Date(receipt.createdAt)))}</td><td><strong>${escapeHtml(receipt.receiptNumber)}</strong></td>
      <td>${escapeHtml(receipt.supplier)}</td><td>${escapeHtml(receipt.items)}</td><td>${escapeHtml(receipt.location)}</td>
      <td>${money.format(receipt.total)}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada penerimaan barang untuk cabang ini.</div>';
}

async function loadMembers() {
  const search = $("#member-search").value.trim();
  const members = await request(`/api/members?q=${encodeURIComponent(search)}`);
  $("#member-count").textContent = `${members.length.toLocaleString("id-ID")} member${members.length === 200 ? " (maksimal ditampilkan)" : ""}`;
  $("#members-table").innerHTML = members.length
    ? `<table><thead><tr><th>NAMA</th><th>NOMOR HP</th><th>SALDO POIN</th><th>TERDAFTAR</th></tr></thead><tbody>${members.map((member) => `
      <tr><td><strong>${escapeHtml(member.name)}</strong></td><td>${escapeHtml(member.phone)}</td>
      <td>${member.pointsBalance.toLocaleString("id-ID")} poin</td>
      <td>${escapeHtml(shortDate.format(new Date(member.createdAt)))}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty-state">${search ? "Tidak ada member yang cocok dengan pencarian." : "Belum ada member. Daftarkan member pertama melalui formulir di atas."}</div>`;
}

async function loadAccounting() {
  const report = await request(`/api/accounting?period=${state.period}`);
  $("#account-revenue").textContent = money.format(report.revenue);
  $("#account-transactions").textContent = `${report.transactions} transaksi`;
  $("#account-cost").textContent = money.format(report.costOfGoods);
  $("#account-expenses").textContent = money.format(report.expenses);
  $("#account-profit").textContent = money.format(report.netProfit);
  await loadAccountingSalesHistory();
  $("#ledger-table").innerHTML = report.ledger.length
    ? `<table><thead><tr><th>TANGGAL</th><th>KETERANGAN</th><th>REFERENSI</th><th>TIPE</th><th>JUMLAH</th></tr></thead><tbody>${report.ledger.map((entry) => `
      <tr><td>${escapeHtml(shortDate.format(new Date(entry.created_at)))}</td><td><strong>${escapeHtml(entry.description)}</strong></td>
      <td>${escapeHtml(entry.reference)}</td><td>${entry.type === "income" ? "Pemasukan" : "Pengeluaran"}</td>
      <td class="${entry.type === "income" ? "amount-cell" : "expense-amount"}">${entry.type === "income" ? "+" : "−"} ${money.format(entry.amount)}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada catatan pada periode ini.</div>';
}

async function loadAccountingSalesHistory() {
  const now = new Date();
  const formatDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const today = formatDate(now);
  const from = state.period === "today"
    ? today
    : formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const search = $("#account-sales-search").value.trim();
  const params = new URLSearchParams({ from, to: today });
  if (search) params.set("q", search);
  const sales = await request(`/api/sales?${params}`);
  $("#account-sales-count").textContent = `${sales.length.toLocaleString("id-ID")} transaksi ditampilkan · maksimal 100 pada periode ini`;
  $("#account-sales-history").innerHTML = sales.length
    ? `<table><thead><tr><th>TANGGAL</th><th>NO. NOTA</th><th>PELANGGAN</th><th>BARANG</th><th>PEMBAYARAN</th><th>TOTAL</th><th></th></tr></thead><tbody>${sales.map((sale) => `
      <tr><td>${escapeHtml(shortDate.format(new Date(sale.createdAt)))}</td>
      <td><strong>${escapeHtml(sale.receiptNumber)}</strong></td>
      <td>${sale.customerType === "member" ? `Member · ${escapeHtml(sale.memberName)}` : "Biasa"}</td>
      <td>${sale.itemCount}</td><td>${escapeHtml(sale.paymentMethod)}</td>
      <td class="amount-cell">${money.format(sale.total)}</td>
      <td><button class="action-button" data-sale-detail="${sale.id}">Lihat nota</button></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty-state">${search ? "Tidak ada transaksi yang cocok pada periode ini." : "Belum ada penjualan pada periode ini."}</div>`;
}

function openProductDialog(product) {
  const form = $("#product-form");
  form.reset();
  form.elements.id.value = product ? product.id : "";
  form.elements.productCodes.value = product ? productCodesOf(product).join("\n") : "";
  form.elements.name.value = product ? product.name : "";
  form.elements.sellingPrice.value = product ? product.sellingPrice : "";
  form.elements.costPrice.value = product ? product.costPrice : "";
  form.elements.promoDiscountPercent.value = product ? product.promoDiscountPercent : "0";
  form.elements.promoBuyQuantity.value = product ? product.promoBuyQuantity : "0";
  form.elements.promoFreeQuantity.value = product ? product.promoFreeQuantity : "0";
  form.elements.promoStartDate.value = product ? product.promoStartDate || "" : "";
  form.elements.promoEndDate.value = product ? product.promoEndDate || "" : "";
  form.elements.stock.value = product ? product.stock : "0";
  form.elements.minStock.value = product ? product.minStock : "5";
  form.elements.category.value = product ? product.category : "Umum";
  $("#product-dialog-title").textContent = product ? "Edit barang" : "Tambah barang";
  $("#product-error").textContent = "";
  $("#product-dialog").showModal();
  form.elements.productCodes.focus();
}

function renderStocktakeRows(search = "") {
  const query = search.trim().toLocaleLowerCase();
  const products = state.stocktakeProducts.filter((product) =>
    !query || [product.name, ...productCodesOf(product)].some((value) =>
      String(value || "").toLocaleLowerCase().includes(query)));
  $("#stocktake-table").innerHTML = products.length
    ? `<table><thead><tr><th>HITUNG</th><th>BARANG</th><th>BARCODE / SKU</th><th>STOK SISTEM</th><th>STOK FISIK</th></tr></thead><tbody>${products.map((product) => {
      const count = state.stocktakeCounts.get(product.id);
      const selected = count !== undefined;
      return `<tr><td><input class="stocktake-check" type="checkbox" data-stocktake-check="${product.id}" aria-label="Pilih ${escapeHtml(product.name)}" ${selected ? "checked" : ""}></td>
        <td><strong>${escapeHtml(product.name)}</strong></td><td>${productCodesOf(product).map(escapeHtml).join("<br>")}</td>
        <td>${product.stock}</td><td><input class="stocktake-quantity" type="number" min="0" step="1" data-stocktake-quantity="${product.id}" placeholder="${product.stock}" value="${selected ? escapeHtml(count) : ""}" ${selected ? "required" : "disabled"} aria-label="Jumlah fisik ${escapeHtml(product.name)}"></td></tr>`;
    }).join("")}</tbody></table>`
    : '<div class="empty-state">Tidak ada produk yang cocok.</div>';
  const count = state.stocktakeCounts.size;
  $("#stocktake-summary").textContent = count
    ? `${count} barang dipilih. Isi jumlah fisik untuk setiap barang yang dicentang.`
    : "Belum ada barang dipilih.";
  $("#save-stocktake-button").disabled = count === 0;
  $("#save-stocktake-button").textContent = count ? `Simpan opname (${count})` : "Simpan opname";
}

const roleLabels = { owner: "Pemilik", manager: "Manajer", cashier: "Kasir" };
const auditEntityLabels = {
  session: "Sesi", register: "Kasir", store: "Cabang", location: "Lokasi", user: "Pengguna", member: "Member", supplier: "Supplier",
  category: "Kategori", product: "Produk", receipt: "Penerimaan barang", stocktake: "Opname stok",
  sale: "Penjualan", expense: "Pengeluaran",
};
const auditActionLabels = {
  setup: "Buat akun awal", login: "Masuk", logout: "Keluar", create: "Tambah", update: "Ubah",
  archive: "Arsipkan", assign: "Tambah stok lokasi", open: "Buka", close: "Tutup",
};
const auditFieldLabels = {
  username: "Nama pengguna", displayName: "Nama", memberName: "Nama member", role: "Peran", storeIds: "Penugasan cabang",
  pinSet: "PIN ditetapkan", pinConfigured: "PIN tersedia", pinChanged: "PIN diubah", active: "Status",
  code: "Kode cabang", type: "Jenis lokasi", phone: "Nomor telepon", contact: "Kontak",
  sku: "Barcode / SKU", barcode: "Barcode / SKU", productCode: "Barcode / SKU", productCodes: "Barcode / SKU", name: "Nama barang", sellingPrice: "Harga jual", costPrice: "Harga modal",
  promoDiscountPercent: "Diskon produk (%)", promoBuyQuantity: "Beli (unit)", promoFreeQuantity: "Gratis (unit)",
  promoStartDate: "Promo mulai", promoEndDate: "Promo berakhir",
  category: "Kategori", stock: "Stok", minStock: "Stok minimum", supplier: "Supplier",
  invoiceNumber: "Nomor faktur", quantity: "Jumlah barang", unitCost: "Harga modal per unit",
  total: "Total", amount: "Jumlah", note: "Catatan", itemCount: "Barang diperiksa",
  changedCount: "Barang disesuaikan", adjustmentUnits: "Unit penyesuaian", delta: "Selisih stok",
  openingCash: "Modal kas awal", closingCash: "Uang kas akhir", expectedCash: "Kas seharusnya",
  cashSales: "Penjualan tunai", salesCount: "Jumlah transaksi", salesTotal: "Total penjualan",
  paymentMethod: "Metode pembayaran", openedAt: "Waktu buka", closedAt: "Waktu tutup",
};

function formatAuditValue(key, value) {
  if (value === undefined) return "belum ada";
  if (value === null || value === "") return "tidak dicatat";
  if (key === "role") return roleLabels[value] || value;
  if (key === "type") return ({ store: "Toko", warehouse: "Gudang", shelf: "Rak" })[value] || value;
  if (key === "storeIds") return `${Array.isArray(value) ? value.length : 0} cabang ditugaskan`;
  if (["isOpen", "pinSet", "pinConfigured", "pinChanged", "active"].includes(key)) {
    if (key === "isOpen") return value ? "Buka" : "Tutup";
    if (key === "active") return value ? "Aktif" : "Nonaktif";
    return value ? "Ya" : "Tidak";
  }
  if (["sellingPrice", "costPrice", "unitCost", "total", "amount", "openingCash", "closingCash",
    "expectedCash", "cashSales", "salesTotal"].includes(key)) return money.format(Number(value));
  if (["openedAt", "closedAt"].includes(key)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : shortDate.format(date);
  }
  if (typeof value === "boolean") return value ? "Ya" : "Tidak";
  if (typeof value === "number") return value.toLocaleString("id-ID");
  return String(value);
}

function describeRegisterAudit(log) {
  const details = [];
  if (log.action === "open") {
    details.push("Kasir dibuka");
    if (log.after?.openingCash !== undefined) {
      details.push(`Modal kas awal ${formatAuditValue("openingCash", log.after.openingCash)}`);
    }
  } else {
    details.push("Kasir ditutup");
    if (log.after?.salesCount !== undefined) {
      details.push(`${formatAuditValue("salesCount", log.after.salesCount)} transaksi`);
    }
    if (log.after?.salesTotal !== undefined) {
      details.push(`Penjualan ${formatAuditValue("salesTotal", log.after.salesTotal)}`);
    }
    if (log.after?.closingCash !== undefined) {
      details.push(`Uang kas akhir ${formatAuditValue("closingCash", log.after.closingCash)}`);
    }
    if (log.after?.expectedCash !== undefined && log.after.expectedCash !== null) {
      details.push(`Kas seharusnya ${formatAuditValue("expectedCash", log.after.expectedCash)}`);
    }
  }
  return details.join(" · ");
}

function describeAuditChanges(log) {
  if (!log.before && !log.after) return "—";
  const before = log.before || {};
  const after = log.after || {};
  if (log.entityType === "register") return describeRegisterAudit(log);
  if (log.entityType === "sale" && after.total !== undefined) {
    const itemCount = Array.isArray(after.items) ? after.items.length : 0;
    return [
      `Transaksi ${formatAuditValue("paymentMethod", after.paymentMethod)}`,
      `${itemCount.toLocaleString("id-ID")} jenis barang`,
      ...(after.discountTotal > 0 ? [`Diskon promo ${formatAuditValue("amount", after.discountTotal)}`] : []),
      `Total ${formatAuditValue("total", after.total)}`,
    ].join(" · ");
  }
  if (log.entityType === "stocktake" && Array.isArray(after.items)) {
    const changedItems = after.items.filter((item) => item.delta !== 0);
    const summary = `${formatAuditValue("itemCount", after.itemCount)} · ${formatAuditValue("changedCount", after.changedCount)}`;
    const examples = changedItems.slice(0, 3).map((item) =>
      `${item.name}: ${formatAuditValue("stock", before.items?.find((entry) => entry.productId === item.productId)?.stock)} → ${formatAuditValue("stock", item.stock)}`);
    return [summary, ...examples].join(" · ");
  }
  if (log.entityType === "receipt" && after.quantity !== undefined) {
    return [
      `Barang diterima dari ${after.supplier || "supplier"}`,
      formatAuditValue("quantity", after.quantity),
      `Total ${formatAuditValue("total", after.total)}`,
      `Stok ${formatAuditValue("stock", before.stock)} → ${formatAuditValue("stock", after.stock)}`,
    ].join(" · ");
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [...keys].filter((key) =>
    auditFieldLabels[key] && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  if (!changes.length) return "Data dicatat";
  return changes.slice(0, 6).map((key) =>
    `${auditFieldLabels[key]}: ${formatAuditValue(key, before[key])} → ${formatAuditValue(key, after[key])}`
  ).join(" · ");
}

async function loadUserManagement() {
  const [users, logs, stores] = await Promise.all([
    request("/api/users"),
    request("/api/audit-logs?limit=200"),
    request("/api/stores"),
  ]);
  state.userStores = stores;
  $("#users-table").innerHTML = users.length
    ? `<table><thead><tr><th>NAMA</th><th>NAMA PENGGUNA</th><th>PERAN</th><th>AKSES CABANG</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody>${users.map((user) => `
      <tr><td><strong>${escapeHtml(user.displayName)}</strong></td><td>${escapeHtml(user.username)}</td><td>${roleLabels[user.role]}</td>
      <td>${user.role === "owner" ? "Semua cabang" : escapeHtml(user.stores.map((store) => store.name).join(", "))}</td>
      <td>${user.active ? "Aktif" : "Nonaktif"}</td><td>${user.role === "owner" ? "—" : `<button class="action-button" data-edit-user="${user.id}">Kelola</button>`}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada akun pengguna.</div>';
  $("#audit-table").innerHTML = logs.length
    ? `<table><thead><tr><th>WAKTU</th><th>PENGGUNA</th><th>AKTIVITAS</th><th>OBJEK</th><th>RINCIAN PERUBAHAN</th><th>CABANG / LOKASI</th></tr></thead><tbody>${logs.map((log) => `
      <tr><td>${escapeHtml(shortDate.format(new Date(log.createdAt)))}</td>
      <td><strong>${escapeHtml(log.username)}</strong><br><small>${roleLabels[log.userRole] || escapeHtml(log.userRole)}</small></td>
      <td>${auditActionLabels[log.action] || escapeHtml(log.action)}</td>
      <td>${auditEntityLabels[log.entityType] || escapeHtml(log.entityType)} ${escapeHtml(log.entityId)}</td>
      <td class="audit-change-cell">${escapeHtml(describeAuditChanges(log))}</td>
      <td>${escapeHtml([log.storeName, log.locationName].filter(Boolean).join(" · ") || "—")}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty-state">Belum ada aktivitas tercatat.</div>';
}

function openUserDialog(user) {
  const form = $("#user-form");
  form.reset();
  form.elements.id.value = user ? user.id : "";
  form.elements.username.value = user ? user.username : "";
  form.elements.displayName.value = user ? user.displayName : "";
  form.elements.role.value = user ? user.role : "cashier";
  form.elements.active.value = user ? String(Boolean(user.active)) : "true";
  form.elements.pin.value = "";
  $("#user-dialog-title").textContent = user ? "Kelola pengguna" : "Tambah pengguna";
  $("#user-pin-hint").textContent = user ? "(kosongkan jika PIN tidak diubah)" : "(6–12 angka)";
  $("#user-error").textContent = "";
  $("#user-store-select").innerHTML = state.userStores.map((store) =>
    `<option value="${store.id}">${escapeHtml(store.name)}</option>`).join("");
  $("#user-store-select").value = String(user?.stores[0]?.id || state.userStores[0]?.id || "");
  form.elements.role.disabled = Boolean(user?.role === "owner");
  form.elements.active.disabled = Boolean(user?.role === "owner");
  form.elements.username.disabled = Boolean(user?.role === "owner");
  form.elements.displayName.disabled = Boolean(user?.role === "owner");
  form.elements.pin.required = !user;
  $("#user-dialog").showModal();
}

function showReceipt(sale) {
  const storeName = sale.storeName || state.stores.find((store) => store.id === state.storeId)?.name || "Toserba Lokal";
  const locationName = sale.locationName || state.locations.find((location) => location.id === state.locationId)?.name;
  const grossSubtotal = sale.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discountTotal = sale.discountTotal === undefined
    ? sale.items.reduce((sum, item) => sum + Number(item.discountAmount || 0), 0)
    : Number(sale.discountTotal);
  const discount = Number(sale.discount || 0);
  const tax = Number(sale.tax || 0);
  const amountPaid = sale.amountPaid === undefined ? null : Number(sale.amountPaid);
  const change = sale.change === undefined ? null : Number(sale.change);
  const transactionDate = shortDate.format(new Date(sale.createdAt));
  const memberDetails = sale.customerType === "member"
    ? `<div class="receipt-summary-row"><span>Nama pelanggan</span><span>${escapeHtml(sale.memberName || "—")}</span></div>
      <div class="receipt-summary-row"><span>Poin transaksi ini</span><span>+${Number(sale.pointsEarned || 0)} poin</span></div>`
    : "";
  const optionalTotals = [
    discountTotal > 0 ? `<div class="receipt-summary-row"><span>Diskon promo</span><span>−${money.format(discountTotal)}</span></div>` : "",
    discount > 0 ? `<div class="receipt-summary-row"><span>Diskon</span><span>−${money.format(discount)}</span></div>` : "",
    tax > 0 ? `<div class="receipt-summary-row"><span>Pajak</span><span>${money.format(tax)}</span></div>` : "",
  ].filter(Boolean).join("");
  const paymentDetails = [
    amountPaid === null ? "" : `<div class="receipt-summary-row"><span>Tunai diterima</span><span>${money.format(amountPaid)}</span></div>`,
    change === null ? "" : `<div class="receipt-summary-row receipt-change"><strong>Kembalian</strong><strong>${money.format(change)}</strong></div>`,
  ].filter(Boolean).join("");
  $("#receipt-content").innerHTML = `
    <header class="receipt-header">
      <div class="receipt-brand-mark">TL</div>
      <h2>${escapeHtml(storeName)}</h2>
      ${locationName ? `<p>${escapeHtml(locationName)}</p>` : ""}
    </header>
    <section class="receipt-meta">
      <div><span>No. Transaksi</span><strong>${escapeHtml(sale.receiptNumber)}</strong></div>
      <div><span>Tanggal</span><strong>${escapeHtml(transactionDate)}</strong></div>
    </section>
    <section class="receipt-items-section">
      <h3>Detail Barang</h3>
      <table class="receipt-items-table">
        <thead><tr><th>Barang</th><th>Qty</th><th>Harga</th><th>Total</th></tr></thead>
        <tbody>${sale.items.map((item) => `
          <tr>
            <td>${escapeHtml(item.name)}${item.discountAmount ? `<small class="receipt-item-discount">${escapeHtml(item.discountLabel || "Diskon promo")} · hemat ${money.format(item.discountAmount)}</small>` : ""}</td>
            <td>${item.quantity}</td>
            <td>${money.format(item.unitPrice)}</td>
            <td>${money.format(item.lineTotal === undefined ? item.unitPrice * item.quantity - Number(item.discountAmount || 0) : item.lineTotal)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </section>
    <section class="receipt-summary">
      <div class="receipt-summary-row"><span>Subtotal</span><span>${money.format(grossSubtotal)}</span></div>
      ${optionalTotals}
      <div class="receipt-summary-row receipt-grand-total"><strong>TOTAL</strong><strong>${money.format(sale.total)}</strong></div>
      ${memberDetails}
      <div class="receipt-summary-row"><span>Metode pembayaran</span><span>${escapeHtml(sale.paymentMethod)}</span></div>
      ${paymentDetails}
    </section>
    <footer class="receipt-footer">
      <p>Terima kasih atas kunjungan Anda.</p>
      <small>Barang yang dibeli tercatat pada transaksi ini.</small>
    </footer>`;
  $("#receipt-dialog").showModal();
}

function resetMemberLookup() {
  state.memberLookup = null;
  $("#member-lookup-status").textContent = "Cari member dengan nomor HP.";
  $("#new-member-name-field").classList.add("hidden");
  $("#new-member-name").value = "";
}

async function lookupMember() {
  const phone = $("#member-phone").value.trim();
  if (!phone) {
    $("#member-lookup-status").textContent = "Masukkan nomor HP member.";
    return;
  }
  const member = await request(`/api/members?phone=${encodeURIComponent(phone)}`);
  state.memberLookup = { phone, found: member.found, name: member.name || "" };
  if (member.found) {
    $("#member-lookup-status").textContent = `${member.name} · saldo ${member.pointsBalance.toLocaleString("id-ID")} poin.`;
    $("#new-member-name-field").classList.add("hidden");
  } else {
    $("#member-lookup-status").textContent = "Nomor belum terdaftar. Isi nama untuk mendaftarkan member saat transaksi.";
    $("#new-member-name-field").classList.remove("hidden");
    $("#new-member-name").focus();
  }
}

$("#gate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const setup = $("#gate-form").dataset.setup === "true";
  const username = $("#username-input").value.trim();
  const pin = $("#pin-input").value;
  try {
    if (setup) {
      await request("/api/setup", { method: "POST", body: JSON.stringify({ pin, username }) });
      $("#gate-error").textContent = "";
      $("#gate-form").dataset.setup = "false";
    }
    await request("/api/login", { method: "POST", body: JSON.stringify({ username, pin }) });
    await initialize();
  } catch (error) {
    $("#gate-error").textContent = error.message;
  }
});

async function logout() {
  await request("/api/logout", { method: "POST" });
  state.cart.clear();
  state.currentUser = null;
  showGate(false);
}

window.toserbaLogout = () => logout().catch(showError);
$("#logout-button").addEventListener("click", window.toserbaLogout);
$("#topbar-logout-button").addEventListener("click", window.toserbaLogout);

$("#store-select").addEventListener("change", async (event) => {
  state.storeId = Number(event.currentTarget.value);
  state.locationId = null;
  state.cart.clear();
  renderCart();
  try {
    await loadStoreContext(state.storeId);
    await refreshCurrentView();
    $("#store-context-dialog").close();
  } catch (error) {
    showError(error);
  }
});
$("#location-select").addEventListener("change", async (event) => {
  state.locationId = Number(event.currentTarget.value);
  localStorage.setItem(`toserba.locationId.${state.storeId}`, String(state.locationId));
  state.cart.clear();
  renderCart();
  await refreshCurrentView().catch(showError);
  $("#store-context-dialog").close();
});
$("#open-store-context").addEventListener("click", async () => {
  try {
    await loadStoreContext(state.storeId);
    $("#store-context-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});
$("#close-store-context").addEventListener("click", () => $("#store-context-dialog").close());
$("#register-toggle-button").addEventListener("click", async () => {
  try {
    await loadRegisterStatus();
    const form = $("#register-form");
    form.reset();
    $("#register-error").textContent = "";
    $("#register-close-summary").classList.add("hidden");
    const closing = state.register.isOpen;
    form.dataset.action = closing ? "close" : "open";
    $("#register-dialog-title").textContent = closing ? "Tutup kasir" : "Buka kasir";
    $("#register-dialog-copy").textContent = closing
      ? `Kasir sudah berjalan sejak ${shortDate.format(new Date(state.register.session.openedAt))}. Menutup kasir akan menghentikan transaksi baru.`
      : `Kasir untuk lokasi ${state.locations.find((location) => location.id === state.locationId)?.name || ""} akan dibuka untuk semua perangkat yang memakai lokasi ini.`;
    $("#register-cash-label").textContent = closing ? "Uang kas akhir (Rp, opsional)" : "Modal kas awal (Rp, opsional)";
    $("#register-submit-button").textContent = closing ? "Tutup kasir" : "Buka kasir";
    $("#register-submit-button").classList.toggle("danger", closing);
    if (closing) {
      const summary = state.register.summary || { salesCount: 0, salesTotal: 0 };
      $("#register-close-summary").innerHTML = `<strong>Ringkasan sementara sesi</strong><span>${summary.salesCount} transaksi</span><span>Penjualan: ${money.format(summary.salesTotal)}</span>`;
      $("#register-close-summary").classList.remove("hidden");
    }
    $("#register-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const action = form.dataset.action;
  const cashValue = form.elements.cash.value;
  const cash = cashValue === "" ? null : Number(cashValue);
  if (cash !== null && (!Number.isSafeInteger(cash) || cash < 0)) {
    $("#register-error").textContent = "Jumlah kas harus berupa Rupiah bulat nol atau lebih.";
    return;
  }
  try {
    const result = await request(`/api/register/${action}`, {
      method: "POST",
      body: JSON.stringify(action === "open" ? { openingCash: cash } : { closingCash: cash }),
    });
    state.register = result;
    $("#register-dialog").close();
    if (action === "close") {
      state.cart.clear();
      renderCart();
      notify(`Kasir ditutup. ${result.summary.salesCount} transaksi, total ${money.format(result.summary.salesTotal)}.`);
    } else {
      notify("Kasir dibuka. Transaksi dapat dilakukan di lokasi ini.");
    }
    await loadRegisterStatus();
    await refreshCurrentView();
  } catch (error) {
    $("#register-error").textContent = error.message;
  }
});
$("#add-store-button").addEventListener("click", () => {
  if ($("#store-context-dialog").open) $("#store-context-dialog").close();
  $("#store-form").reset();
  $("#store-error").textContent = "";
  $("#store-dialog").showModal();
});
$("#store-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await request("/api/stores", {
      method: "POST",
      body: JSON.stringify({ name: new FormData(event.currentTarget).get("name") }),
    });
    $("#store-dialog").close();
    state.locationId = null;
    await loadStoreContext(result.id);
    await refreshCurrentView();
    notify(`Cabang ${result.name} berhasil dibuat.`);
  } catch (error) {
    $("#store-error").textContent = error.message;
  }
});
$("#add-location-button").addEventListener("click", () => {
  if ($("#store-context-dialog").open) $("#store-context-dialog").close();
  $("#location-form").reset();
  $("#location-error").textContent = "";
  $("#location-dialog").showModal();
});
$("#location-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const location = await request("/api/locations", { method: "POST", body: JSON.stringify(values) });
    $("#location-dialog").close();
    localStorage.setItem(`toserba.locationId.${state.storeId}`, String(location.id));
    await loadStoreContext();
    state.cart.clear();
    renderCart();
    await refreshCurrentView();
    notify(`Lokasi ${location.name} berhasil dibuat.`);
  } catch (error) {
    $("#location-error").textContent = error.message;
  }
});

$("#navigation").addEventListener("click", (event) => {
  const button = event.target.closest("[data-view]");
  if (button) switchView(button.dataset.view);
});
document.addEventListener("click", (event) => {
  const saleDetail = event.target.closest("[data-sale-detail]");
  if (saleDetail) openSaleDetail(Number(saleDetail.dataset.saleDetail)).catch(showError);
  const go = event.target.closest("[data-go]");
  if (go) switchView(go.dataset.go);
  const close = event.target.closest("[data-close]");
  if (close) $(`#${close.dataset.close}`).close();
  const add = event.target.closest("[data-add-product]");
  if (add) {
    const product = state.products.find((item) => item.id === Number(add.dataset.addProduct));
    if (product) addToCart(product);
  }
  const cartAction = event.target.closest("[data-cart-action]");
  if (cartAction) {
    const id = Number(cartAction.dataset.productId);
    const item = state.cart.get(id);
    if (!item) return;
    if (cartAction.dataset.cartAction === "increase") {
      if (item.quantity >= item.stock) return notify(`Stok ${item.name} hanya ${item.stock}.`);
      item.quantity += 1;
    } else {
      item.quantity -= 1;
      if (!item.quantity) state.cart.delete(id);
    }
    renderCart();
  }
  const edit = event.target.closest("[data-edit-product]");
  if (edit) {
    request("/api/products").then((items) => {
      const product = items.find((item) => item.id === Number(edit.dataset.editProduct));
      if (product) openProductDialog(product);
    }).catch(showError);
  }
  const editUser = event.target.closest("[data-edit-user]");
  if (editUser) {
    request("/api/users").then((users) => {
      const user = users.find((item) => item.id === Number(editUser.dataset.editUser));
      if (user) openUserDialog(user);
    }).catch(showError);
  }
  const archive = event.target.closest("[data-archive-product]");
  if (archive && window.confirm("Arsipkan barang ini? Barang tidak akan muncul di kasir, tetapi riwayat transaksinya tetap tersimpan.")) {
    request(`/api/products/${archive.dataset.archiveProduct}`, { method: "DELETE" })
      .then(() => loadInventory())
      .then(() => notify("Barang berhasil diarsipkan."))
      .catch(showError);
  }
});

$("#pos-search").addEventListener("input", () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => loadProducts($("#pos-search").value).catch(showError), 180);
});
$("#pos-scan-form").addEventListener("submit", (event) => {
  event.preventDefault();
  scanPosProduct();
});
$("#pos-camera-scan-button").addEventListener("click", () => {
  prepareScanAudio();
  state.cameraMode = "pos";
  $("#barcode-camera-title").textContent = "Scan barang ke keranjang";
  if (window.ToserbaAndroid?.scanBarcode) {
    window.ToserbaAndroid.scanBarcode("pos");
    return;
  }
  startBarcodeCamera("pos").catch((error) => {
    $("#barcode-camera-status").textContent = error.message;
    $("#barcode-camera-dialog").showModal();
  });
});
$("#inventory-search").addEventListener("input", () => {
  clearTimeout(state.inventoryTimer);
  state.inventoryTimer = setTimeout(() => loadInventory().catch(showError), 180);
});
$("#clear-cart").addEventListener("click", () => {
  state.cart.clear();
  renderCart();
});
$("#add-product-button").addEventListener("click", () => openProductDialog());
$("#scan-barcode-button").addEventListener("click", () => {
  state.cameraMode = "product";
  $("#barcode-camera-title").textContent = "Scan barcode barang";
  if (window.ToserbaAndroid?.scanBarcode) {
    window.ToserbaAndroid.scanBarcode("product");
    return;
  }
  startBarcodeCamera("product").catch((error) => {
    $("#barcode-camera-status").textContent = error.message;
    $("#barcode-camera-dialog").showModal();
  });
});
$("#focus-barcode-scanner").addEventListener("click", () => {
  $("#product-form").elements.productCodes.focus();
  notify("Scanner USB/Bluetooth siap. Arahkan ke barcode barang.");
});

async function startBarcodeCamera(mode = "product") {
  state.cameraMode = mode;
  const status = $("#barcode-camera-status");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Akses kamera memerlukan HTTPS atau localhost. Untuk alamat Wi-Fi lokal HTTP, gunakan scanner USB/Bluetooth atau ketik kode.");
  }
  if (!window.ZXingBrowser?.BrowserMultiFormatReader) {
    throw new Error("Pemindai barcode tidak berhasil dimuat. Muat ulang aplikasi atau gunakan scanner USB/Bluetooth.");
  }
  $("#barcode-camera-dialog").showModal();
  status.textContent = mode === "pos"
    ? "Meminta izin kamera. Setiap barcode yang terbaca akan langsung masuk ke keranjang."
    : "Meminta izin kamera. Arahkan kamera ke barcode barang.";
  try {
    state.barcodeReader ||= new window.ZXingBrowser.BrowserMultiFormatReader();
    const video = $("#barcode-camera-video");
    status.textContent = mode === "pos"
      ? "Kamera aktif. Arahkan barcode satu per satu; hasil scan otomatis ditambahkan."
      : "Kamera aktif. Posisikan barcode barang di tengah kamera.";
    const controls = await state.barcodeReader.decodeFromConstraints(
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      video,
      (result, error, scanControls) => {
        if (scanControls) state.cameraControls = scanControls;
        if (result) {
          clearTimeout(state.cameraNoCodeTimer);
          state.cameraNoCodeTimer = null;
          const code = result.getText().trim();
          if (mode === "pos") {
            if (code && code !== state.cameraLastCode) {
              state.cameraLastCode = code;
              status.textContent = `Barcode ${code} terbaca. Mencari barang...`;
              addPosScannedCode(code, { fromScanner: true }).catch((scanError) => {
                status.textContent = scanError.message;
                showError(scanError);
              });
            }
          } else {
            appendProductCode(code);
            $("#barcode-camera-dialog").close();
            $("#product-form").elements.name.focus();
            notify("Barcode berhasil dipindai. Lanjutkan isi detail barang.");
          }
        } else if (error && String(error.name || "").includes("NotFound")) {
          if (state.cameraLastCode && !state.cameraNoCodeTimer) {
            state.cameraNoCodeTimer = setTimeout(() => {
              state.cameraLastCode = "";
              state.cameraNoCodeTimer = null;
            }, 1200);
          }
        } else if (error && !String(error.name || "").includes("NotFound")) {
          status.textContent = `Gagal membaca barcode: ${error.message}. Coba dekatkan barcode atau gunakan scanner USB/Bluetooth.`;
        }
      },
    );
    if ($("#barcode-camera-dialog").open) state.cameraControls = controls;
    else controls.stop();
  } catch (error) {
    stopBarcodeCamera();
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      status.textContent = "Izin kamera ditolak. Izinkan kamera di pengaturan browser, atau gunakan scanner USB/Bluetooth.";
      return;
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      status.textContent = "Kamera tidak ditemukan pada perangkat ini. Gunakan scanner USB/Bluetooth atau ketik kode.";
      return;
    }
    $("#barcode-camera-dialog").close();
    throw new Error(`Kamera tidak dapat dibuka: ${error.message}`);
  }
}

function stopBarcodeCamera() {
  state.cameraControls?.stop();
  state.cameraControls = null;
  clearTimeout(state.cameraNoCodeTimer);
  state.cameraNoCodeTimer = null;
  state.cameraLastCode = "";
}

$("#barcode-camera-dialog").addEventListener("close", stopBarcodeCamera);
$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const id = values.id;
  const body = {
    productCodes: values.productCodes.split(/\r?\n/).map((code) => code.trim()).filter(Boolean),
    name: values.name,
    sellingPrice: Number(values.sellingPrice),
    costPrice: Number(values.costPrice),
    promoDiscountPercent: Number(values.promoDiscountPercent),
    promoBuyQuantity: Number(values.promoBuyQuantity),
    promoFreeQuantity: Number(values.promoFreeQuantity),
    promoStartDate: values.promoStartDate,
    promoEndDate: values.promoEndDate,
    category: values.category,
    stock: Number(values.stock),
    minStock: Number(values.minStock),
  };
  try {
    const savedProduct = await request(id ? `/api/products/${id}` : "/api/products", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#product-dialog").close();
    await loadInventory();
    notify(savedProduct.message || (id ? "Barang berhasil diperbarui." : "Barang berhasil ditambahkan."));
  } catch (error) {
    $("#product-error").textContent = error.message;
  }
});

$("#stocktake-button").addEventListener("click", async () => {
  try {
    state.stocktakeProducts = await request("/api/products");
    state.stocktakeCounts = new Map();
    $("#stocktake-form").reset();
    $("#stocktake-error").textContent = "";
    $("#stocktake-search").value = "";
    renderStocktakeRows();
    $("#stocktake-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});
$("#stocktake-search").addEventListener("input", (event) => renderStocktakeRows(event.currentTarget.value));
$("#stocktake-table").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-stocktake-check]");
  if (!checkbox) return;
  const id = Number(checkbox.dataset.stocktakeCheck);
  if (checkbox.checked) state.stocktakeCounts.set(id, "");
  else state.stocktakeCounts.delete(id);
  renderStocktakeRows($("#stocktake-search").value);
});
$("#stocktake-table").addEventListener("input", (event) => {
  const input = event.target.closest("[data-stocktake-quantity]");
  if (!input) return;
  const id = Number(input.dataset.stocktakeQuantity);
  if (state.stocktakeCounts.has(id)) state.stocktakeCounts.set(id, input.value);
});
$("#stocktake-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const items = [...state.stocktakeCounts.entries()].map(([productId, countedQuantity]) => ({
    productId,
    countedQuantity: Number(countedQuantity),
  }));
  if (items.some((item) => !Number.isSafeInteger(item.countedQuantity) || item.countedQuantity < 0)) {
    $("#stocktake-error").textContent = "Isi jumlah fisik dengan bilangan bulat nol atau lebih untuk semua barang terpilih.";
    return;
  }
  try {
    const stocktake = await request("/api/stocktakes", {
      method: "POST",
      body: JSON.stringify({ items, note: values.note }),
    });
    $("#stocktake-dialog").close();
    await loadInventory();
    notify(`Opname ${stocktake.reference} tersimpan. ${stocktake.changedCount} barang disesuaikan.`);
  } catch (error) {
    $("#stocktake-error").textContent = error.message;
  }
});
$("#stocktake-history").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-stocktake-detail]");
  if (!button) return;
  try {
    const stocktake = await request(`/api/stocktakes/${button.dataset.stocktakeDetail}`);
    $("#stocktake-detail-summary").textContent = `${stocktake.reference} · ${shortDate.format(new Date(stocktake.createdAt))}${stocktake.note ? ` · ${stocktake.note}` : ""}`;
    $("#stocktake-detail-table").innerHTML = `<table><thead><tr><th>BARANG</th><th>BARCODE / SKU</th><th>STOK SISTEM</th><th>STOK FISIK</th><th>SELISIH</th></tr></thead><tbody>${stocktake.items.map((item) => `
      <tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.productCode || item.sku)}</td><td>${item.expectedQuantity}</td>
      <td>${item.countedQuantity}</td><td>${item.quantityDelta > 0 ? "+" : ""}${item.quantityDelta}</td></tr>`).join("")}</tbody></table>`;
    $("#stocktake-detail-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});

$("#receive-stock-button").addEventListener("click", async () => {
  try {
    const [products, suppliers] = await Promise.all([
      request("/api/products"),
      request("/api/suppliers"),
    ]);
    $("#receiving-form").reset();
    $("#receiving-error").textContent = "";
    $("#supplier-list").innerHTML = suppliers.map((supplier) =>
      `<option value="${escapeHtml(supplier.name)}"></option>`).join("");
    $("#receiving-form").elements.productId.innerHTML = products.map((product) =>
      `<option value="${product.id}">${escapeHtml(product.name)} · ${escapeHtml(product.productCode || product.sku)}</option>`).join("");
    if (!products.length) {
      notify("Tambahkan data produk terlebih dahulu sebelum menerima barang.");
      return;
    }
    $("#receiving-form").elements.unitCost.value = products[0].costPrice;
    $("#receiving-dialog").showModal();
  } catch (error) {
    showError(error);
  }
});
$("#receiving-form").elements.productId.addEventListener("change", async (event) => {
  try {
    const product = (await request("/api/products")).find((item) => item.id === Number(event.currentTarget.value));
    if (product) $("#receiving-form").elements.unitCost.value = product.costPrice;
  } catch (error) {
    showError(error);
  }
});
$("#receiving-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const receipt = await request("/api/receipts", {
      method: "POST",
      body: JSON.stringify({
        ...values,
        productId: Number(values.productId),
        quantity: Number(values.quantity),
        unitCost: Number(values.unitCost),
      }),
    });
    $("#receiving-dialog").close();
    await loadInventory();
    notify(`Penerimaan ${receipt.receiptNumber} tercatat dan stok diperbarui.`);
  } catch (error) {
    $("#receiving-error").textContent = error.message;
  }
});

$("#checkout-button").addEventListener("click", async () => {
  if (!state.register.isOpen) {
    notify("Kasir sedang ditutup. Buka kasir terlebih dahulu.");
    return;
  }
  const customerType = $("#customer-type").value;
  const saleCustomer = { customerType };
  if (customerType === "member") {
    const phone = $("#member-phone").value.trim();
    if (!phone) {
      notify("Masukkan nomor HP member.");
      return;
    }
    if (!state.memberLookup || state.memberLookup.phone !== phone) {
      notify("Cari nomor HP member terlebih dahulu.");
      return;
    }
    if (!state.memberLookup.found) {
      const name = $("#new-member-name").value.trim();
      if (!name) {
        notify("Masukkan nama untuk mendaftarkan member baru.");
        $("#new-member-name").focus();
        return;
      }
      saleCustomer.memberName = name;
    }
    saleCustomer.memberPhone = phone;
  }
  const button = $("#checkout-button");
  button.disabled = true;
  try {
    await loadRegisterStatus();
    if (!state.register.isOpen) throw new Error("Kasir sudah ditutup. Buka kasir terlebih dahulu.");
    const sale = await request("/api/sales", {
      method: "POST",
      body: JSON.stringify({
        items: [...state.cart.values()].map((item) => ({ productId: item.id, quantity: item.quantity })),
        paymentMethod: $("#payment-method").value,
        ...saleCustomer,
      }),
    });
    showReceipt(sale);
    state.cart.clear();
    renderCart();
    $("#customer-type").value = "regular";
    $("#member-fields").classList.add("hidden");
    $("#member-phone").value = "";
    resetMemberLookup();
    await loadProducts($("#pos-search").value);
    await loadSalesHistory();
  } catch (error) {
    notify(error.message);
    await loadRegisterStatus().catch(showError);
    await loadProducts($("#pos-search").value).catch(showError);
  } finally {
    button.disabled = !state.register.isOpen || state.cart.size === 0;
  }
});

$("#transaction-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  loadSalesHistory().catch((error) => {
    $("#transaction-history").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  });
});

async function openSaleDetail(id) {
  const sale = await request(`/api/sales/${id}`);
  showReceipt(sale);
}

$("#add-expense-button").addEventListener("click", () => {
  $("#expense-form").reset();
  $("#expense-error").textContent = "";
  $("#expense-dialog").showModal();
});

$("#add-user-button").addEventListener("click", async () => {
  try {
    state.userStores = await request("/api/stores");
    openUserDialog(null);
  } catch (error) {
    showError(error);
  }
});
$("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const body = {
    username: values.username,
    displayName: values.displayName,
    role: values.role,
    active: values.active === "true",
    storeIds: [Number(form.elements.storeId.value)],
  };
  if (values.pin) body.pin = values.pin;
  const id = values.id;
  try {
    await request(id ? `/api/users/${id}` : "/api/users", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#user-dialog").close();
    await loadUserManagement();
    notify(id ? "Akun pengguna berhasil diperbarui." : "Akun pengguna berhasil dibuat.");
  } catch (error) {
    $("#user-error").textContent = error.message;
  }
});
$("#refresh-audit-button").addEventListener("click", () => loadUserManagement().catch(showError));

$("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await request("/api/expenses", {
      method: "POST",
      body: JSON.stringify({ category: values.category, note: values.note, amount: Number(values.amount) }),
    });
    $("#expense-dialog").close();
    await loadAccounting();
    notify("Pengeluaran berhasil dicatat.");
  } catch (error) {
    $("#expense-error").textContent = error.message;
  }
});

$("#customer-type").addEventListener("change", (event) => {
  const isMember = event.currentTarget.value === "member";
  $("#member-fields").classList.toggle("hidden", !isMember);
  if (!isMember) {
    $("#member-phone").value = "";
    resetMemberLookup();
  }
});
$("#member-phone").addEventListener("input", resetMemberLookup);
$("#lookup-member-button").addEventListener("click", () => lookupMember().catch((error) => {
  $("#member-lookup-status").textContent = error.message;
}));
$("#member-phone").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    lookupMember().catch((error) => {
      $("#member-lookup-status").textContent = error.message;
    });
  }
});
$("#member-registration-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  $("#member-registration-status").textContent = "";
  try {
    const values = Object.fromEntries(new FormData(form));
    const member = await request("/api/members", {
      method: "POST",
      body: JSON.stringify(values),
    });
    form.reset();
    $("#member-registration-status").textContent = `Member ${member.name} berhasil didaftarkan.`;
    await loadMembers();
  } catch (error) {
    $("#member-registration-status").textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});
$("#member-search").addEventListener("input", () => {
  clearTimeout(state.memberSearchTimer);
  state.memberSearchTimer = setTimeout(() => loadMembers().catch(showError), 180);
});

$$(".period-button").forEach((button) => button.addEventListener("click", () => {
  state.period = button.dataset.period;
  $$(".period-button").forEach((item) => item.classList.toggle("active", item === button));
  loadAccounting().catch(showError);
}));
$("#account-sales-search").addEventListener("input", () => {
  clearTimeout(state.accountSalesSearchTimer);
  state.accountSalesSearchTimer = setTimeout(() => loadAccountingSalesHistory().catch(showError), 180);
});
$("#print-receipt").addEventListener("click", () => {
  if (window.ToserbaAndroid?.printReceipt) window.ToserbaAndroid.printReceipt();
  else window.print();
});

initialize().catch((error) => {
  showGate(false);
  $("#gate-error").textContent = error.message;
});
