const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createRetailServer, resolveServerBindHost } = require("../server");

test("binds HTTP only to loopback and allows the configured LAN host with TLS", () => {
  assert.equal(resolveServerBindHost({ tlsEnabled: false, configuredHost: "0.0.0.0" }), "127.0.0.1");
  assert.equal(resolveServerBindHost({ tlsEnabled: true, configuredHost: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveServerBindHost({ tlsEnabled: true, configuredHost: "192.168.18.182" }), "192.168.18.182");
});

test("Android network configuration rejects cleartext outside loopback", () => {
  const manifest = fs.readFileSync(path.join(__dirname, "../android/app/src/main/AndroidManifest.xml"), "utf8");
  const networkConfig = fs.readFileSync(path.join(__dirname, "../android/app/src/main/res/xml/network_security_config.xml"), "utf8");
  const mainActivity = fs.readFileSync(path.join(__dirname, "../android/app/src/main/java/com/toserbalokal/mobile/MainActivity.kt"), "utf8");
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(networkConfig, /base-config cleartextTrafficPermitted="false"/);
  assert.match(networkConfig, /<domain includeSubdomains="false">127\.0\.0\.1<\/domain>/);
  assert.match(mainActivity, /scheme == "http" && isLoopbackHost\(host\)/);
  assert.match(mainActivity, /DEFAULT_SERVER_URL = "http:\/\/127\.0\.0\.1:3000"/);
});

async function setupApp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toserba-test-"));
  const app = createRetailServer({ dbPath: path.join(directory, "test.sqlite") });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const createClient = () => {
    let cookie = "";
    return async (route, options = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...options.headers,
        },
      });
      if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
      const contentType = response.headers.get("content-type") || "";
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: contentType.includes("application/json") ? await response.json() : await response.text(),
      };
    };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const api = createClient();
  api.newClient = createClient;
  return api;
}

test("requires both TLS certificate and private key paths to enable HTTPS", () => {
  const previousCert = process.env.TLS_CERT_FILE;
  const previousKey = process.env.TLS_KEY_FILE;
  process.env.TLS_CERT_FILE = "certificate.pem";
  delete process.env.TLS_KEY_FILE;
  try {
    assert.throws(() => createRetailServer({ dbPath: path.join(os.tmpdir(), "tls-config-test.sqlite") }), /TLS_CERT_FILE dan TLS_KEY_FILE harus diatur bersama/);
  } finally {
    if (previousCert === undefined) delete process.env.TLS_CERT_FILE;
    else process.env.TLS_CERT_FILE = previousCert;
    if (previousKey === undefined) delete process.env.TLS_KEY_FILE;
    else process.env.TLS_KEY_FILE = previousKey;
  }
});

test("requires a PIN before accessing store data and accepts initial setup", async (t) => {
  const api = await setupApp(t);
  assert.deepEqual((await api("/api/session")).body, { authenticated: false, setupRequired: true, user: null });
  const scannerScript = await api("/vendor/zxing-browser.min.js");
  assert.equal(scannerScript.status, 200);
  assert.match(scannerScript.headers["content-type"], /text\/javascript/);
  assert.ok(scannerScript.body.length > 300000);
  assert.equal((await api("/api/dashboard")).status, 401);
  assert.equal((await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123" }) })).status, 400);
  assert.equal((await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) })).status, 201);
  assert.equal((await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "000000" }) })).status, 401);
  assert.equal((await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) })).status, 200);
  assert.equal((await api("/api/session")).body.user.role, "owner");
  assert.deepEqual((await api("/api/dashboard")).body.today_sales, 0);
});

test("enforces user roles and branch assignments and records before/after activity", async (t) => {
  const ownerApi = await setupApp(t);
  await ownerApi("/api/setup", { method: "POST", body: JSON.stringify({ username: "pemilik", pin: "123456" }) });
  await ownerApi("/api/login", { method: "POST", body: JSON.stringify({ username: "pemilik", pin: "123456" }) });
  const branch = await ownerApi("/api/stores", {
    method: "POST",
    body: JSON.stringify({ name: "Cabang Selatan" }),
  });
  const secondBranch = await ownerApi("/api/stores", {
    method: "POST",
    body: JSON.stringify({ name: "Cabang Utara" }),
  });
  const branchHeaders = { "X-Store-Id": String(branch.body.id) };
  const branchLocation = (await ownerApi("/api/locations", { headers: branchHeaders })).body[0];
  const branchContext = { ...branchHeaders, "X-Location-Id": String(branchLocation.id) };
  const product = await ownerApi("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "TEST-001", name: "Produk Uji", sellingPrice: 3000, costPrice: 2000, stock: 5, minStock: 1 }),
  });
  await ownerApi("/api/products", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ sku: "TEST-001", name: "Produk Uji", sellingPrice: 3000, costPrice: 2000, stock: 5, minStock: 1 }),
  });
  const manager = await ownerApi("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: "manajer", displayName: "Manajer Cabang", role: "manager", pin: "234567",
      storeIds: [branch.body.id],
    }),
  });
  assert.equal(manager.status, 201);
  assert.equal((await ownerApi("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: "manajer-dua-cabang", displayName: "Manajer Tidak Valid", role: "manager", pin: "234568",
      storeIds: [branch.body.id, secondBranch.body.id],
    }),
  })).status, 400);
  const cashier = await ownerApi("/api/users", {
    method: "POST",
    body: JSON.stringify({
      username: "kasir", displayName: "Kasir Cabang", role: "cashier", pin: "345678",
      storeIds: [branch.body.id],
    }),
  });
  assert.equal(cashier.status, 201);

  const managerApi = ownerApi.newClient();
  assert.equal((await managerApi("/api/login", {
    method: "POST", body: JSON.stringify({ username: "manajer", pin: "234567" }),
  })).status, 200);
  assert.deepEqual((await managerApi("/api/session")).body.user.storeIds, [branch.body.id]);
  assert.deepEqual((await managerApi("/api/stores")).body.map((item) => item.id), [branch.body.id]);
  assert.equal((await managerApi("/api/dashboard", { headers: branchContext })).status, 200);
  assert.equal((await managerApi("/api/accounting", { headers: branchContext })).status, 200);
  assert.equal((await managerApi("/api/products", { headers: branchContext })).status, 200);
  assert.equal((await managerApi("/api/members?q=", { headers: branchContext })).status, 200);
  assert.equal((await managerApi("/api/members", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ name: "Member Manajer", phone: "081234567801" }),
  })).status, 201);
  assert.equal((await managerApi("/api/register", { headers: branchContext })).body.isOpen, false);
  assert.equal((await managerApi("/api/register/open", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ openingCash: 50000 }),
  })).status, 201);
  assert.equal((await managerApi("/api/products", { headers: { "X-Store-Id": "1" } })).status, 403);
  assert.equal((await managerApi("/api/users")).status, 403);
  const updatedProduct = await managerApi(`/api/products/${product.body.id}`, {
    method: "PUT",
    headers: branchContext,
    body: JSON.stringify({
      sku: "TEST-001", name: "Produk Uji Baru", sellingPrice: 4000, costPrice: 2000,
      stock: 5, minStock: 1, category: "Umum",
    }),
  });
  assert.equal(updatedProduct.status, 200);

  const cashierApi = ownerApi.newClient();
  assert.equal((await cashierApi("/api/login", {
    method: "POST", body: JSON.stringify({ username: "kasir", pin: "345678" }),
  })).status, 200);
  assert.deepEqual((await cashierApi("/api/session")).body.user.storeIds, [branch.body.id]);
  assert.equal((await cashierApi("/api/accounting", { headers: branchContext })).status, 403);
  assert.equal((await cashierApi("/api/products", { headers: branchContext })).status, 200);
  assert.deepEqual((await cashierApi("/api/members?phone=081234567890", { headers: branchContext })).body, { found: false });
  assert.equal((await cashierApi("/api/members?q=", { headers: branchContext })).status, 403);
  assert.equal((await cashierApi("/api/members", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ name: "Member Kasir", phone: "081234567802" }),
  })).status, 403);
  const sale = await cashierApi("/api/sales", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ items: [{ productId: product.body.id, quantity: 1 }], paymentMethod: "Tunai" }),
  });
  assert.equal(sale.status, 201);
  const cashierSales = await cashierApi("/api/sales?q=Produk%20Uji", { headers: branchContext });
  assert.equal(cashierSales.status, 200);
  assert.equal(cashierSales.body.length, 1);
  assert.equal(cashierSales.body[0].receiptNumber, sale.body.receiptNumber);
  const cashierSaleDetail = await cashierApi(`/api/sales/${cashierSales.body[0].id}`, { headers: branchContext });
  assert.equal(cashierSaleDetail.status, 200);
  assert.equal(cashierSaleDetail.body.storeName, "Cabang Selatan");
  assert.equal(cashierSaleDetail.body.locationName, branchLocation.name);
  assert.deepEqual(cashierSaleDetail.body.items.map(({ name, quantity, unitPrice, lineTotal }) =>
    ({ name, quantity, unitPrice, lineTotal })), [
    { name: "Produk Uji Baru", quantity: 1, unitPrice: 4000, lineTotal: 4000 },
  ]);
  assert.equal((await cashierApi("/api/sales", { headers: { "X-Store-Id": "1" } })).status, 403);
  assert.equal((await cashierApi(`/api/sales/${cashierSales.body[0].id}`, { headers: { "X-Store-Id": "1" } })).status, 403);
  assert.equal((await cashierApi("/api/register", { headers: branchContext })).body.isOpen, true);
  const closedRegister = await cashierApi("/api/register/close", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ closingCash: 54000 }),
  });
  assert.equal(closedRegister.status, 200);
  assert.equal(closedRegister.body.summary.salesCount, 1);
  assert.equal(closedRegister.body.summary.salesTotal, 4000);
  assert.equal(closedRegister.body.summary.expectedCash, 54000);
  assert.equal((await cashierApi("/api/sales", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ items: [{ productId: product.body.id, quantity: 1 }], paymentMethod: "Tunai" }),
  })).status, 409);
  assert.equal((await cashierApi("/api/products", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ sku: "FORBIDDEN", name: "Tidak boleh", sellingPrice: 1, costPrice: 1, stock: 0, minStock: 0 }),
  })).status, 403);

  const logs = (await ownerApi("/api/audit-logs?limit=200")).body;
  const productUpdate = logs.find((log) => log.entityType === "product" && log.action === "update" && log.username === "manajer");
  assert.ok(productUpdate);
  assert.equal(productUpdate.before.name, "Produk Uji");
  assert.equal(productUpdate.after.name, "Produk Uji Baru");
  const saleLog = logs.find((log) => log.entityType === "sale" && log.username === "kasir");
  assert.ok(saleLog);
  assert.equal(saleLog.after.total, 4000);
  assert.equal((await managerApi("/api/audit-logs")).status, 403);

  assert.equal((await ownerApi(`/api/users/${cashier.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ active: false }),
  })).status, 200);
  assert.equal((await cashierApi("/api/products", { headers: branchContext })).status, 401);
});

test("limits repeated incorrect PIN attempts", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "000000" }) })).status, 401);
  }
  const blocked = await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
});

test("supports multiple barcode/SKU codes per product and preserves leading zeroes", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });

  const barcode = "0896860102034";
  const alternateSku = "MINUM-MULTIPACK-01";
  const longSku = "K".repeat(1000);
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      productCodes: [barcode, alternateSku, longSku],
      name: "Minuman kemasan", sellingPrice: 5000, costPrice: 3000, stock: 5, minStock: 1,
    }),
  });
  assert.equal(product.status, 201);
  assert.deepEqual(product.body.productCodes, [barcode, alternateSku, longSku]);

  const search = await api(`/api/products?q=${barcode}`);
  assert.equal(search.body.length, 1);
  assert.equal(search.body[0].productCode, barcode);
  assert.deepEqual(search.body[0].productCodes, [barcode, alternateSku, longSku]);
  assert.equal(search.body[0].sku, barcode);
  assert.equal(search.body[0].barcode, barcode);
  const alternateSearch = await api(`/api/products?q=${alternateSku}`);
  assert.equal(alternateSearch.body.length, 1);
  assert.equal(alternateSearch.body[0].id, product.body.id);

  const duplicate = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ productCodes: [alternateSku], name: "Produk duplikat", sellingPrice: 6000, costPrice: 3000, stock: 2, minStock: 1 }),
  });
  assert.equal(duplicate.status, 409);

  const manualSku = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ productCode: "SKU-MANUAL-1", name: "Produk kode manual", sellingPrice: 7000, costPrice: 4000, stock: 1, minStock: 0 }),
  });
  assert.equal(manualSku.status, 201);

  const legacyClient = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "SKU-MANUAL-2", barcode: "", name: "Produk klien lama", sellingPrice: 7000, costPrice: 4000, stock: 1, minStock: 0 }),
  });
  assert.equal(legacyClient.status, 201);
  assert.equal(legacyClient.body.productCode, "SKU-MANUAL-2");
  assert.deepEqual(legacyClient.body.productCodes, ["SKU-MANUAL-2"]);

  const shortCode = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ productCode: "A", name: "Kode satu karakter", sellingPrice: 1000, costPrice: 500, stock: 1, minStock: 0 }),
  });
  assert.equal(shortCode.status, 201);
  assert.equal((await api("/api/products?q=A")).body.find((item) => item.id === shortCode.body.id).productCode, "A");

  const updated = await api(`/api/products/${product.body.id}`, {
    method: "PUT",
    body: JSON.stringify({
      productCodes: ["0000123456789", alternateSku], name: "Minuman kemasan",
      sellingPrice: 5000, costPrice: 3000, stock: 5, minStock: 1,
    }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.productCodes, ["0000123456789", alternateSku]);
  assert.equal((await api("/api/products?q=0000123456789")).body[0].sku, "0000123456789");
  assert.deepEqual((await api(`/api/products?q=${barcode}`)).body, []);
  assert.equal((await api(`/api/products?q=${alternateSku}`)).body[0].id, product.body.id);

  const tooLongCode = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      productCode: "Z".repeat(1001), name: "Kode terlalu panjang",
      sellingPrice: 1000, costPrice: 500, stock: 1, minStock: 0,
    }),
  });
  assert.equal(tooLongCode.status, 400);

  const legacy = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      sku: "LEGACY-INTERNAL", barcode: "0896860102035", name: "Produk data lama",
      sellingPrice: 5000, costPrice: 3000, stock: 1, minStock: 0,
    }),
  });
  assert.equal(legacy.status, 201);
  const legacyLookup = await api("/api/products?q=0896860102035");
  assert.equal(legacyLookup.body[0].productCode, "0896860102035");
  assert.equal(legacyLookup.body[0].sku, "0896860102035");
  assert.deepEqual(legacyLookup.body[0].productCodes, ["0896860102035", "LEGACY-INTERNAL"]);
  assert.equal((await api("/api/products?q=LEGACY-INTERNAL")).body[0].id, legacy.body.id);
});

test("records stocktakes as per-location stock adjustments and provides an audit history", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "MINUM-001", name: "Minuman teh", sellingPrice: 5000, costPrice: 3000, stock: 5, minStock: 1 }),
  });
  const emptyProduct = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "SNACK-001", name: "Keripik", sellingPrice: 2000, costPrice: 1000, stock: 0, minStock: 2 }),
  });

  const stocktake = await api("/api/stocktakes", {
    method: "POST",
    body: JSON.stringify({
      note: "Opname rak minuman",
      items: [
        { productId: product.body.id, countedQuantity: 2 },
        { productId: emptyProduct.body.id, countedQuantity: 0 },
      ],
    }),
  });
  assert.equal(stocktake.status, 201);
  assert.equal(stocktake.body.itemCount, 2);
  assert.equal(stocktake.body.changedCount, 1);
  assert.equal(stocktake.body.adjustmentUnits, 3);
  assert.equal((await api("/api/products?q=MINUM-001")).body[0].stock, 2);

  const history = await api("/api/stocktakes");
  assert.equal(history.body.length, 1);
  assert.equal(history.body[0].reference, stocktake.body.reference);
  assert.equal(history.body[0].changedCount, 1);
  const detail = await api(`/api/stocktakes/${stocktake.body.id}`);
  assert.equal(detail.body.items.find((item) => item.sku === "MINUM-001").quantityDelta, -3);
  assert.equal(detail.body.items.find((item) => item.sku === "SNACK-001").countedQuantity, 0);
  const stocktakeLog = (await api("/api/audit-logs")).body.find((log) => log.entityType === "stocktake");
  assert.equal(stocktakeLog.before.items[0].stock, 5);
  assert.equal(stocktakeLog.after.items[0].stock, 2);

  const invalid = await api("/api/stocktakes", {
    method: "POST",
    body: JSON.stringify({ items: [
      { productId: product.body.id, countedQuantity: 1 },
      { productId: 99999, countedQuantity: 4 },
    ] }),
  });
  assert.equal(invalid.status, 409);
  assert.equal((await api("/api/products?q=MINUM-001")).body[0].stock, 2);
  assert.equal((await api("/api/stocktakes")).body.length, 1);
  assert.equal((await api(`/api/stocktakes/${stocktake.body.id}`, {
    headers: { "X-Location-Id": "99999" },
  })).status, 400);
});

test("isolates branch and location stock, records supplier receipts, and scopes sales", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  const mainLocation = (await api("/api/locations")).body[0];
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      sku: "MINUM-001", name: "Minuman teh", category: "Minuman",
      sellingPrice: 5000, costPrice: 3000, stock: 5, minStock: 1,
    }),
  });
  const branch = await api("/api/stores", {
    method: "POST",
    body: JSON.stringify({ name: "Cabang Selatan" }),
  });
  assert.equal(branch.status, 201);
  const branchHeaders = { "X-Store-Id": String(branch.body.id) };
  const branchLocation = (await api("/api/locations", { headers: branchHeaders })).body[0];

  const assignedProduct = await api("/api/products", {
    method: "POST",
    headers: { ...branchHeaders, "X-Location-Id": String(branchLocation.id) },
    body: JSON.stringify({
      sku: "MINUM-001", name: "Minuman teh", category: "Minuman",
      sellingPrice: 5000, costPrice: 3000, stock: 4, minStock: 1,
    }),
  });
  assert.equal(assignedProduct.status, 200);
  assert.equal(assignedProduct.body.id, product.body.id);
  assert.match(assignedProduct.body.message, /harga katalog dipertahankan/i);
  assert.equal((await api("/api/products", {
    headers: { ...branchHeaders, "X-Location-Id": String(branchLocation.id) },
  })).body[0].stock, 4);
  assert.equal((await api("/api/products", {
    headers: { "X-Location-Id": String(mainLocation.id) },
  })).body[0].stock, 5);

  const receipt = await api("/api/receipts", {
    method: "POST",
    headers: { ...branchHeaders, "X-Location-Id": String(branchLocation.id) },
    body: JSON.stringify({
      supplierName: "Supplier Teh", invoiceNumber: "INV-001",
      productId: product.body.id, quantity: 6, unitCost: 4000,
    }),
  });
  assert.equal(receipt.status, 201);
  const branchProducts = await api("/api/products", {
    headers: { ...branchHeaders, "X-Location-Id": String(branchLocation.id) },
  });
  assert.equal(branchProducts.body[0].stock, 10);
  assert.equal(branchProducts.body[0].costPrice, 3600);
  assert.equal((await api("/api/receipts", { headers: branchHeaders })).body[0].supplier, "Supplier Teh");

  const branchContext = { ...branchHeaders, "X-Location-Id": String(branchLocation.id) };
  assert.equal((await api("/api/register", { headers: branchContext })).body.isOpen, false);
  assert.equal((await api("/api/register/open", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({}),
  })).status, 201);
  const sale = await api("/api/sales", {
    method: "POST",
    headers: branchContext,
    body: JSON.stringify({ items: [{ productId: product.body.id, quantity: 2 }], paymentMethod: "QRIS" }),
  });
  assert.equal(sale.status, 201);
  await api("/api/expenses", {
    method: "POST",
    headers: branchHeaders,
    body: JSON.stringify({ category: "Transportasi", amount: 1000 }),
  });
  const branchAccounting = await api("/api/accounting?period=month", { headers: branchHeaders });
  assert.equal(branchAccounting.body.revenue, 10000);
  assert.equal(branchAccounting.body.costOfGoods, 7200);
  assert.equal(branchAccounting.body.expenses, 1000);
  assert.equal(branchAccounting.body.netProfit, 1800);
  const mainAccounting = await api("/api/accounting?period=month");
  assert.equal(mainAccounting.body.revenue, 0);
  assert.equal(mainAccounting.body.expenses, 0);
  assert.equal((await api("/api/products", {
    headers: { ...branchHeaders, "X-Location-Id": String(branchLocation.id) },
  })).body[0].stock, 8);

  const newLocation = await api("/api/locations", {
    method: "POST",
    headers: branchHeaders,
    body: JSON.stringify({ name: "Gudang belakang", type: "warehouse" }),
  });
  assert.equal(newLocation.status, 201);
  const newLocationContext = { ...branchHeaders, "X-Location-Id": String(newLocation.body.id) };
  assert.equal((await api("/api/products", { headers: newLocationContext })).body[0].stock, 0);
  assert.equal((await api("/api/register", { headers: newLocationContext })).body.isOpen, false);
  assert.equal((await api("/api/sales", {
    method: "POST",
    headers: newLocationContext,
    body: JSON.stringify({ items: [{ productId: product.body.id, quantity: 1 }], paymentMethod: "Tunai" }),
  })).status, 409);
});

test("register sessions gate sales and preserve per-location cash summaries", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "KAS-1", name: "Barang kasir", sellingPrice: 1000, costPrice: 500, stock: 5, minStock: 1 }),
  });
  const saleBody = JSON.stringify({ items: [{ productId: product.body.id, quantity: 1 }], paymentMethod: "Tunai" });

  assert.equal((await api("/api/register")).body.isOpen, false);
  assert.equal((await api("/api/sales", { method: "POST", body: saleBody })).status, 409);
  assert.equal((await api("/api/register/open", {
    method: "POST",
    body: JSON.stringify({ openingCash: 100 }),
  })).status, 201);
  assert.equal((await api("/api/register/open", {
    method: "POST",
    body: JSON.stringify({}),
  })).status, 409);
  assert.equal((await api("/api/sales", { method: "POST", body: saleBody })).status, 201);

  const closing = await api("/api/register/close", {
    method: "POST",
    body: JSON.stringify({ closingCash: 1100 }),
  });
  assert.equal(closing.status, 200);
  assert.equal(closing.body.summary.salesCount, 1);
  assert.equal(closing.body.summary.salesTotal, 1000);
  assert.equal(closing.body.summary.cashSales, 1000);
  assert.equal(closing.body.summary.expectedCash, 1100);
  assert.equal((await api("/api/sales", { method: "POST", body: saleBody })).status, 409);
  assert.equal((await api("/api/register/open", {
    method: "POST",
    body: JSON.stringify({}),
  })).status, 201);
  assert.equal((await api("/api/sales", { method: "POST", body: saleBody })).status, 201);

});

test("registers members by phone and awards one point per Rp10,000 spent", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  const product = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "MEM-1", name: "Belanja member", sellingPrice: 25000, costPrice: 12000, stock: 5, minStock: 1 }),
  });
  await api("/api/register/open", { method: "POST", body: JSON.stringify({}) });

  assert.equal((await api("/api/members?phone=abc")).status, 400);
  const missingName = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: product.body.id, quantity: 1 }],
      paymentMethod: "Tunai", customerType: "member", memberPhone: "081234567890",
    }),
  });
  assert.equal(missingName.status, 400);
  assert.deepEqual((await api("/api/members?phone=081234567890")).body, { found: false });

  const registeredMember = await api("/api/members", {
    method: "POST",
    body: JSON.stringify({ name: "Pelanggan Member", phone: "+62 812-3456-7890" }),
  });
  assert.equal(registeredMember.status, 201);
  assert.equal(registeredMember.body.phone, "081234567890");
  assert.equal(registeredMember.body.pointsBalance, 0);
  assert.equal((await api("/api/members", {
    method: "POST",
    body: JSON.stringify({ name: "Member Duplikat", phone: "0812 3456 7890" }),
  })).status, 409);
  assert.equal((await api("/api/members?q=Pelanggan%20Member")).body.length, 1);
  assert.equal((await api("/api/members?q=081234567890")).body.length, 1);

  const firstSale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: product.body.id, quantity: 1 }],
      paymentMethod: "Tunai", customerType: "member",
      memberPhone: "+62 812-3456-7890",
    }),
  });
  assert.equal(firstSale.status, 201);
  assert.equal(firstSale.body.pointsEarned, 2);
  assert.equal(firstSale.body.pointsBalance, 2);
  assert.equal(firstSale.body.memberName, "Pelanggan Member");

  const member = await api("/api/members?phone=081234567890");
  assert.deepEqual(member.body, {
    found: true, id: 1, name: "Pelanggan Member", phone: "081234567890", pointsBalance: 2,
  });
  const secondSale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: product.body.id, quantity: 1 }],
      paymentMethod: "QRIS", customerType: "member", memberPhone: "0812 3456 7890",
    }),
  });
  assert.equal(secondSale.status, 201);
  assert.equal(secondSale.body.pointsBalance, 4);

  const history = await api("/api/sales?q=081234567890");
  assert.equal(history.body.length, 2);
  const detail = await api(`/api/sales/${history.body[0].id}`);
  assert.equal(detail.body.customerType, "member");
  assert.equal(detail.body.memberName, "Pelanggan Member");
  assert.equal(detail.body.pointsEarned, 2);

  const regularSale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [{ productId: product.body.id, quantity: 1 }],
      paymentMethod: "Tunai", customerType: "regular",
    }),
  });
  assert.equal(regularSale.status, 201);
  assert.equal(regularSale.body.pointsEarned, 0);
  assert.equal(regularSale.body.pointsBalance, 0);
  assert.equal((await api("/api/members?phone=081234567890")).body.pointsBalance, 4);
});

test("applies dated product discounts and buy-X-get-Y promotions without stacking", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  const localDate = (date) => [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  const todayDate = new Date();
  const today = localDate(todayDate);
  const yesterdayDate = new Date(todayDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const twoDaysAgoDate = new Date(todayDate);
  twoDaysAgoDate.setDate(twoDaysAgoDate.getDate() - 2);
  const yesterday = localDate(yesterdayDate);
  const twoDaysAgo = localDate(twoDaysAgoDate);
  const createProduct = async (sku, name, sellingPrice, promotion = {}) => api("/api/products", {
    method: "POST",
    body: JSON.stringify({
      sku, name, sellingPrice, costPrice: 500, stock: 10, minStock: 1,
      promoDiscountPercent: 0, promoBuyQuantity: 0, promoFreeQuantity: 0,
      ...promotion,
    }),
  });
  const percent = await createProduct("PROMO-PCT", "Promo persen", 1000, { promoDiscountPercent: 25 });
  const buyTwoFreeOne = await createProduct("PROMO-B2G1", "Promo beli dua gratis satu", 1500, {
    promoBuyQuantity: 2, promoFreeQuantity: 1,
  });
  const quantityWins = await createProduct("PROMO-BEST-QTY", "Promo terbaik jumlah", 1000, {
    promoDiscountPercent: 40, promoBuyQuantity: 1, promoFreeQuantity: 1,
  });
  const percentageWins = await createProduct("PROMO-BEST-PCT", "Promo terbaik persen", 1000, {
    promoDiscountPercent: 60, promoBuyQuantity: 2, promoFreeQuantity: 1,
  });
  const expired = await createProduct("PROMO-EXPIRED", "Promo berakhir", 2000, {
    promoDiscountPercent: 50, promoStartDate: twoDaysAgo, promoEndDate: yesterday,
  });
  const dateBounded = await createProduct("PROMO-DATE", "Promo hari ini", 25000, {
    promoDiscountPercent: 50, promoStartDate: today, promoEndDate: today,
  });
  const editable = await createProduct("PROMO-EDIT", "Promo diperbarui", 3000);
  const updatedPromotion = await api(`/api/products/${editable.body.id}`, {
    method: "PUT",
    body: JSON.stringify({
      productCodes: ["PROMO-EDIT"], name: "Promo diperbarui", sellingPrice: 3000,
      costPrice: 500, stock: 10, minStock: 1, category: "Umum",
      promoDiscountPercent: 15, promoStartDate: today, promoEndDate: today,
    }),
  });
  assert.equal(percent.status, 201);
  assert.equal(buyTwoFreeOne.status, 201);
  assert.equal(quantityWins.status, 201);
  assert.equal(percentageWins.status, 201);
  assert.equal(expired.status, 201);
  assert.equal(dateBounded.status, 201);
  assert.equal(updatedPromotion.status, 200);
  assert.equal((await createProduct("PROMO-INVALID", "Promo tanggal tidak valid", 1000, {
    promoDiscountPercent: 10, promoStartDate: "2026-02-31", promoEndDate: "2026-03-01",
  })).status, 400);
  assert.equal((await createProduct("PROMO-INCOMPLETE", "Promo jumlah tidak lengkap", 1000, {
    promoBuyQuantity: 2,
  })).status, 400);

  const catalog = await api("/api/products");
  assert.equal(catalog.body.find((product) => product.id === expired.body.id).promoActive, false);
  assert.equal(catalog.body.find((product) => product.id === dateBounded.body.id).promoActive, true);
  assert.equal(catalog.body.find((product) => product.id === editable.body.id).promoDiscountPercent, 15);

  await api("/api/register/open", { method: "POST", body: JSON.stringify({}) });
  const sale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({
      items: [
        { productId: percent.body.id, quantity: 2 },
        { productId: buyTwoFreeOne.body.id, quantity: 3 },
        { productId: quantityWins.body.id, quantity: 2 },
        { productId: percentageWins.body.id, quantity: 3 },
        { productId: expired.body.id, quantity: 1 },
        { productId: dateBounded.body.id, quantity: 1 },
      ],
      paymentMethod: "Tunai", customerType: "member",
      memberPhone: "081234567802", memberName: "Pelanggan Promo",
    }),
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.subtotal, 38500);
  assert.equal(sale.body.discountTotal, 17300);
  assert.equal(sale.body.total, 21200);
  assert.equal(sale.body.pointsEarned, 2);
  assert.deepEqual(sale.body.items.map((item) => ({
    discountAmount: item.discountAmount, discountLabel: item.discountLabel, lineTotal: item.lineTotal,
  })), [
    { discountAmount: 500, discountLabel: "Diskon produk 25%", lineTotal: 1500 },
    { discountAmount: 1500, discountLabel: "Beli 2 gratis 1", lineTotal: 3000 },
    { discountAmount: 1000, discountLabel: "Beli 1 gratis 1", lineTotal: 1000 },
    { discountAmount: 1800, discountLabel: "Diskon produk 60%", lineTotal: 1200 },
    { discountAmount: 0, discountLabel: "", lineTotal: 2000 },
    { discountAmount: 12500, discountLabel: "Diskon produk 50%", lineTotal: 12500 },
  ]);
  assert.equal((await api("/api/products?q=PROMO-B2G1")).body[0].stock, 7);
  const history = await api(`/api/sales?q=${encodeURIComponent(sale.body.receiptNumber)}`);
  const detail = await api(`/api/sales/${history.body[0].id}`);
  assert.equal(detail.body.memberName, "Pelanggan Promo");
  assert.equal(detail.body.items[1].discountAmount, 1500);
  assert.equal(detail.body.items[1].lineTotal, 3000);
  assert.equal((await api("/api/members?phone=081234567802")).body.pointsBalance, 2);
});

test("creates products, records a sale, deducts stock, and reflects expenses in accounting", async (t) => {
  const api = await setupApp(t);
  await api("/api/setup", { method: "POST", body: JSON.stringify({ pin: "123456" }) });
  await api("/api/login", { method: "POST", body: JSON.stringify({ pin: "123456" }) });

  const created = await api("/api/products", {
    method: "POST",
    body: JSON.stringify({ sku: "BRG-1", name: "Beras 5 kg", sellingPrice: 80000, costPrice: 65000, stock: 3, minStock: 1 }),
  });
  assert.equal(created.status, 201);
  const productId = created.body.id;
  assert.equal((await api("/api/register/open", {
    method: "POST",
    body: JSON.stringify({}),
  })).status, 201);
  const sale = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({ items: [{ productId, quantity: 2 }], paymentMethod: "Tunai" }),
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.body.total, 160000);
  assert.deepEqual(sale.body.items, [{
    name: "Beras 5 kg", quantity: 2, unitPrice: 80000, discountAmount: 0, discountLabel: "", lineTotal: 160000,
  }]);
  const salesByReceipt = await api(`/api/sales?q=${encodeURIComponent(sale.body.receiptNumber)}`);
  assert.equal(salesByReceipt.status, 200);
  assert.equal(salesByReceipt.body.length, 1);
  assert.equal(salesByReceipt.body[0].itemCount, 1);
  const salesByProduct = await api("/api/sales?q=Beras");
  assert.equal(salesByProduct.body.length, 1);
  const salesByMethod = await api("/api/sales?q=Tunai");
  assert.equal(salesByMethod.body.length, 1);
  const createdDate = new Date(sale.body.createdAt);
  const saleDay = [createdDate.getFullYear(), String(createdDate.getMonth() + 1).padStart(2, "0"), String(createdDate.getDate()).padStart(2, "0")].join("-");
  const salesForAccountingPeriod = await api(`/api/sales?from=${saleDay}&to=${saleDay}`);
  assert.equal(salesForAccountingPeriod.body.length, 1);
  const saleDetail = await api(`/api/sales/${salesByReceipt.body[0].id}`);
  assert.equal(saleDetail.status, 200);
  assert.equal(saleDetail.body.receiptNumber, sale.body.receiptNumber);
  assert.equal(saleDetail.body.total, 160000);
  assert.equal(saleDetail.body.storeName, "Toserba Utama");
  assert.ok(saleDetail.body.locationName);
  assert.deepEqual(saleDetail.body.items, [{
    name: "Beras 5 kg", sku: "BRG-1", quantity: 2, unitPrice: 80000, unitCost: 65000,
    discountAmount: 0, discountLabel: "", lineTotal: 160000,
  }]);
  assert.equal((await api("/api/sales?q=tidak-ada")).body.length, 0);
  assert.equal((await api("/api/sales?from=2026-99-99")).status, 400);
  assert.equal((await api("/api/sales?from=2026-11-25&to=2026-11-24")).status, 400);
  assert.equal((await api("/api/sales/999999")).status, 404);

  const insufficient = await api("/api/sales", {
    method: "POST",
    body: JSON.stringify({ items: [{ productId, quantity: 2 }], paymentMethod: "QRIS" }),
  });
  assert.equal(insufficient.status, 409);

  const products = await api("/api/products");
  assert.equal(products.body[0].stock, 1);
  await api("/api/expenses", {
    method: "POST",
    body: JSON.stringify({ category: "Listrik & air", note: "Tagihan", amount: 10000 }),
  });
  const accounting = await api("/api/accounting?period=month");
  assert.equal(accounting.body.revenue, 160000);
  assert.equal(accounting.body.costOfGoods, 130000);
  assert.equal(accounting.body.expenses, 10000);
  assert.equal(accounting.body.netProfit, 20000);
  assert.equal(accounting.body.ledger.length, 2);
  assert.equal((await api(`/api/products/${productId}`, { method: "DELETE" })).status, 200);
  assert.deepEqual((await api("/api/products")).body, []);
  assert.equal((await api("/api/accounting?period=month")).body.ledger.length, 2);
});

test("migrates existing single-store product stock into the default location", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toserba-legacy-"));
  const dbPath = path.join(directory, "legacy.sqlite");
  const legacyDb = new DatabaseSync(dbPath);
  const legacySalt = "00112233445566778899aabbccddeeff";
  const legacyHash = crypto.scryptSync("123456", Buffer.from(legacySalt, "hex"), 64).toString("hex");
  const legacySessionToken = "a".repeat(64);
  legacyDb.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY, sku TEXT NOT NULL COLLATE NOCASE UNIQUE, barcode TEXT, name TEXT NOT NULL,
      selling_price INTEGER NOT NULL, cost_price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0,
      min_stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE sales (
      id INTEGER PRIMARY KEY, receipt_number TEXT NOT NULL UNIQUE, total INTEGER NOT NULL,
      cost_total INTEGER NOT NULL, payment_method TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE sale_items (
      id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id INTEGER REFERENCES products(id), sku TEXT NOT NULL, product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, unit_cost INTEGER NOT NULL
    );
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE inventory_movements (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL, quantity_delta INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);
  legacyDb.prepare("INSERT INTO settings (key, value) VALUES ('pin_salt', ?)").run(legacySalt);
  legacyDb.prepare("INSERT INTO settings (key, value) VALUES ('pin_hash', ?)").run(legacyHash);
  legacyDb.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(
    crypto.createHash("sha256").update(legacySessionToken).digest("hex"),
    Date.now() + 60 * 60 * 1000,
  );
  legacyDb.prepare(`
    INSERT INTO products (sku, barcode, name, selling_price, cost_price, stock, min_stock, created_at)
    VALUES ('OLD-001', '0001234567890', 'Produk lama', 9000, 6000, 7, 2, ?)
  `).run(new Date().toISOString());
  legacyDb.prepare(`
    INSERT INTO sales (receipt_number, total, cost_total, payment_method, created_at)
    VALUES ('OLD-RECEIPT-1', 9000, 6000, 'Tunai', ?)
  `).run(new Date().toISOString());
  legacyDb.prepare(`
    INSERT INTO expenses (category, amount, created_at) VALUES ('Sewa', 1000, ?)
  `).run(new Date().toISOString());
  legacyDb.close();

  const app = createRetailServer({ dbPath });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  let cookie = `toserba_session=${legacySessionToken}`;
  const api = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  assert.equal((await api("/api/session")).body.setupRequired, false);
  assert.equal((await api("/api/session")).body.user.role, "owner");
  await api("/api/logout", { method: "POST" });
  const migratedOwnerLogin = await api("/api/login", {
    method: "POST", body: JSON.stringify({ username: "pemilik", pin: "123456" }),
  });
  assert.equal(migratedOwnerLogin.status, 200);
  assert.equal((await api("/api/session")).body.user.role, "owner");
  const migrated = await api("/api/products?q=OLD-001");
  assert.equal(migrated.status, 200);
  assert.equal(migrated.body[0].stock, 7);
  assert.equal(migrated.body[0].productCode, "0001234567890");
  assert.equal(migrated.body[0].sku, "0001234567890");
  assert.deepEqual(migrated.body[0].productCodes, ["0001234567890", "OLD-001"]);
  assert.equal(migrated.body[0].minStock, 2);
  assert.equal(migrated.body[0].barcode, "0001234567890");
  const updatedLegacyProduct = await api(`/api/products/${migrated.body[0].id}`, {
    method: "PUT",
    body: JSON.stringify({
      productCode: "0001234567890", name: "Produk lama",
      sellingPrice: 9000, costPrice: 6000, stock: 7, minStock: 2,
    }),
  });
  assert.equal(updatedLegacyProduct.status, 200);
  const savedLegacyProduct = await api("/api/products?q=0001234567890");
  assert.equal(savedLegacyProduct.body[0].sku, "0001234567890");
  assert.equal(savedLegacyProduct.body[0].barcode, "0001234567890");
  const migratedAccounting = await api("/api/accounting?period=month");
  assert.equal(migratedAccounting.body.revenue, 9000);
  assert.equal(migratedAccounting.body.expenses, 1000);
});
