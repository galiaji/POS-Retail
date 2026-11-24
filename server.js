const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const SESSION_COOKIE = "toserba_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MIME_TYPES = {
  ".apk": "application/vnd.android.package-archive",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      user_id INTEGER REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'cashier')),
      pin_salt TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_stores (
      user_id INTEGER NOT NULL REFERENCES users(id),
      store_id INTEGER NOT NULL REFERENCES stores(id),
      PRIMARY KEY (user_id, store_id)
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL,
      user_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL DEFAULT '',
      store_id INTEGER REFERENCES stores(id),
      location_id INTEGER REFERENCES locations(id),
      before_data TEXT,
      after_data TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'store',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE (store_id, name)
    );
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      sku TEXT NOT NULL COLLATE NOCASE UNIQUE,
      barcode TEXT,
      name TEXT NOT NULL,
      selling_price INTEGER NOT NULL CHECK (selling_price >= 0),
      cost_price INTEGER NOT NULL CHECK (cost_price >= 0),
      promo_discount_percent INTEGER NOT NULL DEFAULT 0 CHECK (promo_discount_percent BETWEEN 0 AND 100),
      promo_buy_quantity INTEGER NOT NULL DEFAULT 0 CHECK (promo_buy_quantity >= 0),
      promo_free_quantity INTEGER NOT NULL DEFAULT 0 CHECK (promo_free_quantity >= 0),
      promo_start_date TEXT,
      promo_end_date TEXT,
      category_id INTEGER REFERENCES categories(id),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_codes (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      code TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE (product_id, code)
    );
    CREATE TABLE IF NOT EXISTS inventory_balances (
      product_id INTEGER NOT NULL REFERENCES products(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      min_stock INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
      cost_price INTEGER CHECK (cost_price >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (product_id, location_id)
    );
    CREATE TABLE IF NOT EXISTS stocktakes (
      id INTEGER PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id INTEGER PRIMARY KEY,
      stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      expected_quantity INTEGER NOT NULL CHECK (expected_quantity >= 0),
      counted_quantity INTEGER NOT NULL CHECK (counted_quantity >= 0),
      quantity_delta INTEGER NOT NULL,
      UNIQUE (stocktake_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS register_sessions (
      id INTEGER PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      opened_by INTEGER NOT NULL REFERENCES users(id),
      opened_by_name TEXT NOT NULL,
      opening_cash INTEGER CHECK (opening_cash >= 0),
      opened_at TEXT NOT NULL,
      closed_by INTEGER REFERENCES users(id),
      closed_by_name TEXT,
      closing_cash INTEGER CHECK (closing_cash >= 0),
      closed_at TEXT,
      sales_count INTEGER,
      sales_total INTEGER
    );
    CREATE TABLE IF NOT EXISTS purchase_receipts (
      id INTEGER PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      location_id INTEGER NOT NULL REFERENCES locations(id),
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      invoice_number TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL CHECK (total >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchase_receipt_items (
      id INTEGER PRIMARY KEY,
      receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0)
    );
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY,
      receipt_number TEXT NOT NULL UNIQUE,
      total INTEGER NOT NULL,
      cost_total INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      customer_type TEXT NOT NULL DEFAULT 'regular',
      member_id INTEGER REFERENCES members(id),
      member_name TEXT NOT NULL DEFAULT '',
      member_phone TEXT NOT NULL DEFAULT '',
      points_earned INTEGER NOT NULL DEFAULT 0,
      location_id INTEGER REFERENCES locations(id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      product_id INTEGER REFERENCES products(id),
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price INTEGER NOT NULL,
      unit_cost INTEGER NOT NULL,
      discount_amount INTEGER NOT NULL DEFAULT 0,
      discount_label TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL CHECK (amount > 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      movement_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sales_created_at_idx ON sales(created_at);
    CREATE INDEX IF NOT EXISTS expenses_created_at_idx ON expenses(created_at);
    CREATE INDEX IF NOT EXISTS inventory_product_idx ON inventory_movements(product_id, created_at);
  `);
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const addColumn = (table, name, definition) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn("sales", "store_id", "INTEGER REFERENCES stores(id)");
  addColumn("sales", "location_id", "INTEGER REFERENCES locations(id)");
  addColumn("sales", "customer_type", "TEXT NOT NULL DEFAULT 'regular'");
  addColumn("sales", "member_id", "INTEGER REFERENCES members(id)");
  addColumn("sales", "member_name", "TEXT NOT NULL DEFAULT ''");
  addColumn("sales", "member_phone", "TEXT NOT NULL DEFAULT ''");
  addColumn("sales", "points_earned", "INTEGER NOT NULL DEFAULT 0");
  addColumn("expenses", "store_id", "INTEGER REFERENCES stores(id)");
  addColumn("inventory_movements", "store_id", "INTEGER REFERENCES stores(id)");
  addColumn("inventory_movements", "location_id", "INTEGER REFERENCES locations(id)");
  addColumn("products", "category_id", "INTEGER REFERENCES categories(id)");
  addColumn("products", "barcode", "TEXT");
  addColumn("products", "promo_discount_percent", "INTEGER NOT NULL DEFAULT 0");
  addColumn("products", "promo_buy_quantity", "INTEGER NOT NULL DEFAULT 0");
  addColumn("products", "promo_free_quantity", "INTEGER NOT NULL DEFAULT 0");
  addColumn("products", "promo_start_date", "TEXT");
  addColumn("products", "promo_end_date", "TEXT");
  addColumn("sale_items", "discount_amount", "INTEGER NOT NULL DEFAULT 0");
  addColumn("sale_items", "discount_label", "TEXT NOT NULL DEFAULT ''");
  addColumn("sessions", "user_id", "INTEGER REFERENCES users(id)");

  const createdAt = new Date().toISOString();
  const insertProductCode = db.prepare(`
    INSERT OR IGNORE INTO product_codes (product_id, code, created_at) VALUES (?, ?, ?)
  `);
  for (const product of db.prepare("SELECT id, sku, barcode, created_at FROM products ORDER BY id").all()) {
    const codes = [product.barcode, product.sku].filter((code) => typeof code === "string" && code.trim());
    for (const code of [...new Set(codes)]) insertProductCode.run(product.id, code.trim(), product.created_at || createdAt);
  }
  db.prepare(`
    INSERT OR IGNORE INTO stores (id, code, name, created_at)
    VALUES (1, 'MAIN', 'Toserba Utama', ?)
  `).run(createdAt);
  db.prepare(`
    INSERT OR IGNORE INTO locations (store_id, name, location_type, created_at)
    VALUES (1, 'Toko Utama', 'store', ?)
  `).run(createdAt);
  db.prepare("INSERT OR IGNORE INTO categories (name, created_at) VALUES ('Umum', ?)").run(createdAt);

  const defaultLocation = db.prepare(`
    SELECT id FROM locations WHERE store_id = 1 AND location_type = 'store' ORDER BY id LIMIT 1
  `).get();
  const legacyPinHash = db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get();
  const legacyPinSalt = db.prepare("SELECT value FROM settings WHERE key = 'pin_salt'").get();
  if (legacyPinHash && legacyPinSalt && !db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
    const result = db.prepare(`
      INSERT INTO users
        (username, display_name, role, pin_salt, pin_hash, active, created_at, updated_at)
      VALUES ('pemilik', 'Pemilik', 'owner', ?, ?, 1, ?, ?)
    `).run(legacyPinSalt.value, legacyPinHash.value, createdAt, createdAt);
    db.prepare("UPDATE sessions SET user_id = ? WHERE user_id IS NULL").run(Number(result.lastInsertRowid));
  }
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  if (owner) {
    db.prepare("INSERT OR IGNORE INTO user_stores (user_id, store_id) SELECT ?, id FROM stores").run(owner.id);
  }
  db.prepare("UPDATE sales SET store_id = 1 WHERE store_id IS NULL").run();
  db.prepare("UPDATE sales SET location_id = ? WHERE location_id IS NULL").run(defaultLocation.id);
  db.prepare("UPDATE expenses SET store_id = 1 WHERE store_id IS NULL").run();
  db.prepare(`
    UPDATE inventory_movements
    SET store_id = 1, location_id = ?
    WHERE store_id IS NULL OR location_id IS NULL
  `).run(defaultLocation.id);

  db.prepare(`
    INSERT OR IGNORE INTO inventory_balances
      (product_id, location_id, stock, min_stock, cost_price, updated_at)
    SELECT id, ?, stock, min_stock, cost_price, ?
    FROM products
  `).run(defaultLocation.id, createdAt);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique
      ON products(barcode COLLATE NOCASE) WHERE barcode IS NOT NULL AND barcode <> '';
    CREATE INDEX IF NOT EXISTS product_codes_code_idx ON product_codes(code COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS product_codes_product_idx ON product_codes(product_id, id);
    CREATE INDEX IF NOT EXISTS sales_store_created_idx ON sales(store_id, created_at);
    CREATE INDEX IF NOT EXISTS expenses_store_created_idx ON expenses(store_id, created_at);
    CREATE INDEX IF NOT EXISTS locations_store_idx ON locations(store_id, active);
    CREATE INDEX IF NOT EXISTS purchases_store_created_idx ON purchase_receipts(store_id, created_at);
    CREATE INDEX IF NOT EXISTS stocktakes_store_location_created_idx ON stocktakes(store_id, location_id, created_at);
    CREATE INDEX IF NOT EXISTS stocktake_items_product_idx ON stocktake_items(product_id);
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS user_stores_store_idx ON user_stores(store_id, user_id);
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_store_idx ON audit_logs(store_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS register_sessions_location_idx ON register_sessions(store_id, location_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS register_sessions_one_open_per_location
      ON register_sessions(location_id) WHERE closed_at IS NULL;
  `);
  return db;
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Permintaan terlalu besar."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Format JSON tidak valid."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function cookieValue(req, name) {
  const cookies = req.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isUniqueConstraint(error) {
  return error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.errcode === 2067;
}

function parseMoney(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`${field} harus berupa bilangan Rupiah bulat nol atau lebih.`), { status: 400 });
  }
  return value;
}

function parseProductPromotions(body) {
  const promoDiscountPercent = body.promoDiscountPercent === undefined ? 0 : body.promoDiscountPercent;
  const promoBuyQuantity = body.promoBuyQuantity === undefined ? 0 : body.promoBuyQuantity;
  const promoFreeQuantity = body.promoFreeQuantity === undefined ? 0 : body.promoFreeQuantity;
  if (!Number.isSafeInteger(promoDiscountPercent) || promoDiscountPercent < 0 || promoDiscountPercent > 100) {
    throw Object.assign(new Error("Diskon produk harus berupa persentase bulat 0–100."), { status: 400 });
  }
  if (![promoBuyQuantity, promoFreeQuantity].every((quantity) =>
    Number.isSafeInteger(quantity) && quantity >= 0 && quantity <= 10000)) {
    throw Object.assign(new Error("Jumlah beli dan gratis harus berupa bilangan bulat 0–10.000."), { status: 400 });
  }
  if ((promoBuyQuantity === 0) !== (promoFreeQuantity === 0)) {
    throw Object.assign(new Error("Jumlah beli dan jumlah gratis harus diisi bersama."), { status: 400 });
  }
  const optionalDate = (value) => value === undefined || value === null || value === "" ? null : value;
  const promoStartDate = optionalDate(body.promoStartDate);
  const promoEndDate = optionalDate(body.promoEndDate);
  const validDate = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if ((promoStartDate === null) !== (promoEndDate === null)) {
    throw Object.assign(new Error("Tanggal mulai dan berakhir promo harus diisi bersama."), { status: 400 });
  }
  if (promoStartDate !== null && (!validDate(promoStartDate) || !validDate(promoEndDate))) {
    throw Object.assign(new Error("Tanggal promo harus berupa tanggal yang valid."), { status: 400 });
  }
  if (promoStartDate && promoStartDate > promoEndDate) {
    throw Object.assign(new Error("Tanggal mulai promo tidak boleh melewati tanggal berakhir."), { status: 400 });
  }
  const hasPromotion = promoDiscountPercent > 0 || promoBuyQuantity > 0;
  if (!hasPromotion && (promoStartDate || promoEndDate)) {
    throw Object.assign(new Error("Atur diskon atau promo jumlah beli sebelum mengisi masa berlaku."), { status: 400 });
  }
  return { promoDiscountPercent, promoBuyQuantity, promoFreeQuantity, promoStartDate, promoEndDate };
}

function calculateLinePromotion(product, quantity, today) {
  const configured = product.promo_discount_percent > 0 || product.promo_buy_quantity > 0;
  const inDateRange = (!product.promo_start_date || product.promo_start_date <= today)
    && (!product.promo_end_date || product.promo_end_date >= today);
  if (!configured || !inDateRange) return { discountAmount: 0, discountLabel: "" };

  const discountPerUnit = Math.floor(product.selling_price / 100) * product.promo_discount_percent
    + Math.floor((product.selling_price % 100) * product.promo_discount_percent / 100);
  const percentDiscount = discountPerUnit * quantity;
  const freeQuantity = product.promo_buy_quantity > 0
    ? Math.floor(quantity / (product.promo_buy_quantity + product.promo_free_quantity)) * product.promo_free_quantity
    : 0;
  const quantityDiscount = product.selling_price * freeQuantity;
  if (percentDiscount >= quantityDiscount && percentDiscount > 0) {
    return { discountAmount: percentDiscount, discountLabel: `Diskon produk ${product.promo_discount_percent}%` };
  }
  if (quantityDiscount > 0) {
    return {
      discountAmount: quantityDiscount,
      discountLabel: `Beli ${product.promo_buy_quantity} gratis ${product.promo_free_quantity}`,
    };
  }
  return { discountAmount: 0, discountLabel: "" };
}

function requiredText(value, field, maxLength = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${field} wajib diisi (maksimal ${maxLength} karakter).`), { status: 400 });
  }
  return value.trim();
}

function normalizeMemberPhone(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("Nomor HP member wajib diisi."), { status: 400 });
  }
  if (!/^[+\d\s()-]+$/.test(value.trim())) {
    throw Object.assign(new Error("Nomor HP hanya boleh berisi angka, spasi, dan tanda +, -, atau kurung."), { status: 400 });
  }
  let phone = value.replace(/\D/g, "");
  if (phone.startsWith("62")) phone = `0${phone.slice(2)}`;
  if (phone.length < 8 || phone.length > 15) {
    throw Object.assign(new Error("Nomor HP member harus terdiri dari 8–15 angka."), { status: 400 });
  }
  return phone;
}

function requiredProductCodes(body) {
  let values;
  if (Array.isArray(body.productCodes)) {
    values = body.productCodes;
  } else if (typeof body.productCodes === "string") {
    values = body.productCodes.split(/\r?\n/);
  } else if (body.productCode !== undefined) {
    values = [body.productCode];
  } else {
    values = [body.barcode, body.sku].filter((value) => value !== undefined && value !== null && value !== "");
  }
  if (!values.length) {
    throw Object.assign(new Error("Minimal satu Barcode / SKU wajib diisi."), { status: 400 });
  }
  const codes = values.map((value) => requiredText(value, "Barcode / SKU", 1000));
  if (new Set(codes.map((code) => code.toLocaleLowerCase())).size !== codes.length) {
    throw Object.assign(new Error("Kode Barcode / SKU tidak boleh berulang pada produk yang sama."), { status: 400 });
  }
  return codes;
}

function localDateModifier(period) {
  if (period === "today") return "start of day";
  if (period === "month") return "start of month";
  throw Object.assign(new Error("Periode tidak valid."), { status: 400 });
}

function loadTlsOptions() {
  const certPath = process.env.TLS_CERT_FILE;
  const keyPath = process.env.TLS_KEY_FILE;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error("TLS_CERT_FILE dan TLS_KEY_FILE harus diatur bersama untuk mengaktifkan HTTPS.");
  }
  return {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

function createRetailServer({
  dbPath = process.env.RETAIL_DB_PATH || path.join(ROOT, "data", "toserba.sqlite"),
  tlsOptions = loadTlsOptions(),
} = {}) {
  const db = openDatabase(dbPath);
  const loginAttempts = new Map();

  function getSessionUser(req) {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, u.role, s.expires_at AS expiresAt
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND u.active = 1
    `).get(tokenHash);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return session;
  }

  function audit(actor, action, entityType, entityId, beforeData, afterData, storeId = null, locationId = null, createdAt = new Date().toISOString()) {
    db.prepare(`
      INSERT INTO audit_logs
        (user_id, username, user_role, action, entity_type, entity_id, store_id, location_id, before_data, after_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actor.id, actor.username, actor.role, action, entityType, String(entityId ?? ""),
      storeId, locationId, beforeData === null ? null : JSON.stringify(beforeData),
      afterData === null ? null : JSON.stringify(afterData), createdAt,
    );
  }

  function inTransaction(operation) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getAccessibleStoreIds(userId) {
    return db.prepare("SELECT store_id AS id FROM user_stores WHERE user_id = ? ORDER BY store_id").all(userId).map((store) => store.id);
  }

  function getStoreContext(req, user, includeLocation = true) {
    const rawStoreId = req.headers["x-store-id"] || "1";
    const storeId = Number(rawStoreId);
    if (!Number.isSafeInteger(storeId) || storeId < 1) {
      throw Object.assign(new Error("Cabang tidak valid."), { status: 400 });
    }
    const store = db.prepare("SELECT id, name FROM stores WHERE id = ? AND active = 1").get(storeId);
    if (!store) throw Object.assign(new Error("Cabang tidak ditemukan atau tidak aktif."), { status: 404 });
    if (user.role !== "owner") {
      const assignedStore = db.prepare(`
        SELECT store_id AS id FROM user_stores WHERE user_id = ? ORDER BY store_id LIMIT 1
      `).get(user.id);
      if (!assignedStore || assignedStore.id !== storeId) {
        throw Object.assign(new Error("Akun ini hanya dapat mengakses cabang yang ditugaskan."), { status: 403 });
      }
    }
    if (!includeLocation) return { storeId, store, locationId: null };

    const rawLocationId = req.headers["x-location-id"];
    const location = rawLocationId
      ? db.prepare("SELECT id FROM locations WHERE id = ? AND store_id = ? AND active = 1").get(Number(rawLocationId), storeId)
      : db.prepare("SELECT id FROM locations WHERE store_id = ? AND active = 1 ORDER BY id LIMIT 1").get(storeId);
    if (!location) throw Object.assign(new Error("Lokasi stok tidak valid untuk cabang terpilih."), { status: 400 });
    return { storeId, store, locationId: location.id };
  }

  function createSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    db.prepare("INSERT INTO sessions (token_hash, expires_at, user_id) VALUES (?, ?, ?)").run(
      crypto.createHash("sha256").update(token).digest("hex"),
      expiresAt,
      userId,
    );
    return token;
  }

  function requireRole(actor, roles) {
    if (!roles.includes(actor.role)) {
      throw Object.assign(new Error("Akses ditolak untuk peran akun ini."), { status: 403 });
    }
  }

  function getRegisterStatus(storeId, locationId) {
    const active = db.prepare(`
      SELECT id, opened_by AS openedBy, opened_by_name AS openedByName,
        opening_cash AS openingCash, opened_at AS openedAt
      FROM register_sessions
      WHERE store_id = ? AND location_id = ? AND closed_at IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(storeId, locationId);
    return active ? { isOpen: true, session: active } : { isOpen: false, session: null };
  }

  function serveStatic(req, res, pathname) {
    const requested = pathname === "/" ? "/index.html" : pathname;
    const vendorScript = "/vendor/zxing-browser.min.js";
    const target = pathname === vendorScript
      ? path.join(ROOT, "node_modules", "@zxing", "browser", "umd", "zxing-browser.min.js")
      : path.resolve(PUBLIC_DIR, `.${requested}`);
    if (pathname !== vendorScript && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
      sendJson(res, 404, { error: "Halaman tidak ditemukan." });
      return;
    }
    fs.readFile(target, (error, content) => {
      if (error) {
        sendJson(res, 404, { error: "Halaman tidak ditemukan." });
        return;
      }
      res.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": MIME_TYPES[path.extname(target)] || "application/octet-stream",
        ...(path.extname(target) === ".apk"
          ? { "Content-Disposition": 'attachment; filename="toserba-lokal.apk"' }
          : {}),
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
      });
      res.end(content);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/session") {
      const setupRequired = !db.prepare("SELECT 1 FROM users LIMIT 1").get()
        && !db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get();
      const user = getSessionUser(req);
      sendJson(res, 200, {
        authenticated: Boolean(user),
        setupRequired,
        user: user ? {
          id: user.id, username: user.username, displayName: user.displayName, role: user.role,
          storeIds: user.role === "owner"
            ? db.prepare("SELECT id FROM stores WHERE active = 1 ORDER BY id").all().map((store) => store.id)
            : getAccessibleStoreIds(user.id).slice(0, 1),
        } : null,
      });
      return;
    }

    if (route === "POST /api/setup") {
      const body = await readBody(req);
      if (typeof body.pin !== "string" || !/^\d{6,12}$/.test(body.pin)) {
        sendJson(res, 400, { error: "PIN harus terdiri dari 6–12 angka." });
        return;
      }
      const username = body.username === undefined ? "pemilik" : requiredText(body.username, "Nama pengguna", 40);
      if (!/^[\p{L}\p{N}._-]+$/u.test(username)) {
        sendJson(res, 400, { error: "Nama pengguna hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung." });
        return;
      }
      const salt = crypto.randomBytes(16);
      const hash = crypto.scryptSync(body.pin, salt, 64);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (db.prepare("SELECT value FROM settings WHERE key = 'pin_hash'").get()) {
          db.exec("ROLLBACK");
          sendJson(res, 409, { error: "PIN sudah dibuat. Silakan masuk." });
          return;
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('pin_salt', ?)").run(salt.toString("hex"));
        db.prepare("INSERT INTO settings (key, value) VALUES ('pin_hash', ?)").run(hash.toString("hex"));
        const createdAt = new Date().toISOString();
        const user = db.prepare(`
          INSERT INTO users
            (username, display_name, role, pin_salt, pin_hash, active, created_at, updated_at)
          VALUES (?, 'Pemilik', 'owner', ?, ?, 1, ?, ?)
        `).run(username, salt.toString("hex"), hash.toString("hex"), createdAt, createdAt);
        const owner = { id: Number(user.lastInsertRowid), username, role: "owner" };
        db.prepare("INSERT INTO user_stores (user_id, store_id) SELECT ?, id FROM stores").run(owner.id);
        audit(owner, "setup", "user", owner.id, null, { username, displayName: "Pemilik", role: "owner" }, null, null, createdAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(res, 201, { message: "PIN pemilik berhasil dibuat." });
      return;
    }

    if (route === "POST /api/login") {
      const body = await readBody(req);
      const username = typeof body.username === "string" && body.username.trim() ? body.username.trim() : "pemilik";
      const clientAddress = req.socket.remoteAddress || "unknown";
      const attempt = loginAttempts.get(clientAddress);
      if (attempt && attempt.blockedUntil > Date.now()) {
        sendJson(res, 429, { error: "Terlalu banyak percobaan. Coba lagi dalam 15 menit." }, {
          "Retry-After": String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)),
        });
        return;
      }
      if (attempt && attempt.blockedUntil > 0 && attempt.blockedUntil <= Date.now()) {
        loginAttempts.delete(clientAddress);
      }
      const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1").get(username);
      if (!user || typeof body.pin !== "string" || !/^\d{6,12}$/.test(body.pin)) {
        const failures = (loginAttempts.get(clientAddress)?.failures || 0) + 1;
        loginAttempts.set(clientAddress, {
          failures,
          blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
        });
        sendJson(res, 401, { error: "PIN tidak valid." });
        return;
      }
      const supplied = crypto.scryptSync(body.pin, Buffer.from(user.pin_salt, "hex"), 64).toString("hex");
      if (!safeEqual(supplied, user.pin_hash)) {
        const failures = (loginAttempts.get(clientAddress)?.failures || 0) + 1;
        loginAttempts.set(clientAddress, {
          failures,
          blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
        });
        sendJson(res, 401, { error: "PIN tidak valid." });
        return;
      }
      loginAttempts.delete(clientAddress);
      const token = inTransaction(() => {
        const sessionToken = createSession(user.id);
        audit(user, "login", "session", "", null, { role: user.role });
        return sessionToken;
      });
      sendJson(res, 200, { authenticated: true, user: { username: user.username, displayName: user.display_name, role: user.role } }, {
        "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${tlsOptions ? "; Secure" : ""}`,
      });
      return;
    }

    if (route === "POST /api/logout") {
      const actor = getSessionUser(req);
      const token = cookieValue(req, SESSION_COOKIE);
      if (token || actor) inTransaction(() => {
        if (token) {
          db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
            crypto.createHash("sha256").update(token).digest("hex"),
          );
        }
        if (actor) audit(actor, "logout", "session", "", null, null);
      });
      sendJson(res, 200, { authenticated: false }, {
        "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${tlsOptions ? "; Secure" : ""}`,
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const actor = getSessionUser(req);
      if (!actor) {
        sendJson(res, 401, { error: "Sesi berakhir. Silakan masuk kembali." });
        return;
      }
      const roleRoutes = {
        owner: null,
        manager: new Set([
          "GET /api/stores", "GET /api/locations", "POST /api/locations",
          "GET /api/suppliers", "POST /api/suppliers", "GET /api/categories", "POST /api/categories",
          "POST /api/receipts", "GET /api/receipts", "GET /api/dashboard",
          "GET /api/products", "POST /api/products", "PUT /api/products/:id", "DELETE /api/products/:id",
          "GET /api/stocktakes", "GET /api/stocktakes/:id", "POST /api/stocktakes",
          "POST /api/sales", "GET /api/sales", "GET /api/sales/:id",
          "GET /api/members", "POST /api/members", "GET /api/accounting", "POST /api/expenses",
          "GET /api/register", "POST /api/register/open", "POST /api/register/close",
        ]),
        cashier: new Set([
          "GET /api/stores", "GET /api/locations", "GET /api/products", "POST /api/sales",
          "GET /api/sales", "GET /api/sales/:id", "GET /api/members",
          "GET /api/register", "POST /api/register/open", "POST /api/register/close",
        ]),
      };
      const normalizedRoute = route.replace(/^PUT \/api\/products\/\d+$/, "PUT /api/products/:id")
        .replace(/^DELETE \/api\/products\/\d+$/, "DELETE /api/products/:id")
        .replace(/^GET \/api\/stocktakes\/\d+$/, "GET /api/stocktakes/:id")
        .replace(/^GET \/api\/sales\/\d+$/, "GET /api/sales/:id");
      if (actor.role !== "owner" && !roleRoutes[actor.role]?.has(normalizedRoute)) {
        sendJson(res, 403, { error: "Akses ditolak untuk peran akun ini." });
        return;
      }
      if (route === "GET /api/users" || route === "POST /api/users"
        || route === "GET /api/audit-logs" || route.startsWith("PUT /api/users/")) {
        requireRole(actor, ["owner"]);
      }
      if (route === "GET /api/members" && actor.role === "cashier" && !url.searchParams.has("phone")) {
        sendJson(res, 403, { error: "Daftar member hanya dapat diakses pemilik dan manajer." });
        return;
      }
      if (route === "GET /api/stores") {
        const stores = actor.role === "owner"
          ? db.prepare("SELECT id, code, name FROM stores WHERE active = 1 ORDER BY id").all()
          : db.prepare(`
            SELECT s.id, s.code, s.name FROM stores s
            JOIN user_stores us ON us.store_id = s.id
            WHERE s.active = 1 AND us.user_id = ? ORDER BY s.id LIMIT 1
          `).all(actor.id);
        sendJson(res, 200, stores);
        return;
      }
      if (route === "GET /api/users") {
        const users = db.prepare(`
          SELECT id, username, display_name AS displayName, role, active, created_at AS createdAt
          FROM users ORDER BY id
        `).all();
        sendJson(res, 200, users.map((user) => ({
          ...user,
          stores: db.prepare(`
            SELECT s.id, s.name FROM user_stores us
            JOIN stores s ON s.id = us.store_id
            WHERE us.user_id = ? ORDER BY s.id
          `).all(user.id),
        })));
        return;
      }
      if (route === "POST /api/users") {
        const body = await readBody(req);
        const username = requiredText(body.username, "Nama pengguna", 40);
        if (!/^[\p{L}\p{N}._-]+$/u.test(username)) {
          throw Object.assign(new Error("Nama pengguna hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung."), { status: 400 });
        }
        const displayName = requiredText(body.displayName, "Nama", 100);
        if (!["manager", "cashier"].includes(body.role)) {
          throw Object.assign(new Error("Peran akun baru harus manajer atau kasir."), { status: 400 });
        }
        if (typeof body.pin !== "string" || !/^\d{6,12}$/.test(body.pin)) {
          throw Object.assign(new Error("PIN harus terdiri dari 6–12 angka."), { status: 400 });
        }
        if (!Array.isArray(body.storeIds) || body.storeIds.length !== 1
          || body.storeIds.some((id) => !Number.isSafeInteger(id) || id < 1)
          || new Set(body.storeIds).size !== body.storeIds.length) {
          throw Object.assign(new Error("Setiap akun manajer atau kasir harus ditugaskan tepat ke satu cabang."), { status: 400 });
        }
        const stores = db.prepare(`SELECT id FROM stores WHERE active = 1 AND id IN (${body.storeIds.map(() => "?").join(",")})`).all(...body.storeIds);
        if (stores.length !== body.storeIds.length) throw Object.assign(new Error("Ada cabang yang tidak ditemukan atau tidak aktif."), { status: 400 });
        const salt = crypto.randomBytes(16);
        const hash = crypto.scryptSync(body.pin, salt, 64);
        const createdAt = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = db.prepare(`
            INSERT INTO users
              (username, display_name, role, pin_salt, pin_hash, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          `).run(username, displayName, body.role, salt.toString("hex"), hash.toString("hex"), createdAt, createdAt);
          const userId = Number(result.lastInsertRowid);
          const assignStore = db.prepare("INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)");
          for (const assignedStoreId of body.storeIds) assignStore.run(userId, assignedStoreId);
          const after = { id: userId, username, displayName, role: body.role, active: true, pinSet: true, storeIds: body.storeIds };
          audit(actor, "create", "user", userId, null, after, null, null, createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, after);
        } catch (error) {
          db.exec("ROLLBACK");
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Nama pengguna sudah digunakan." });
            return;
          }
          throw error;
        }
        return;
      }
      const userMatch = url.pathname.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && req.method === "PUT") {
        const userId = Number(userMatch[1]);
        const body = await readBody(req);
        const current = db.prepare(`
          SELECT id, username, display_name AS displayName, role, active FROM users WHERE id = ?
        `).get(userId);
        if (!current) {
          sendJson(res, 404, { error: "Akun tidak ditemukan." });
          return;
        }
        const isActive = body.active === undefined ? Boolean(current.active) : body.active;
        if (typeof isActive !== "boolean") throw Object.assign(new Error("Status akun tidak valid."), { status: 400 });
        if (userId === actor.id && !isActive) throw Object.assign(new Error("Akun yang sedang digunakan tidak dapat dinonaktifkan."), { status: 400 });
        if (current.role === "owner" && (body.role && body.role !== "owner" || !isActive)) {
          throw Object.assign(new Error("Akun pemilik tidak dapat diubah menjadi peran lain atau dinonaktifkan."), { status: 400 });
        }
        if (current.role === "owner" && body.storeIds !== undefined) {
          throw Object.assign(new Error("Akses cabang akun pemilik tidak dapat dibatasi."), { status: 400 });
        }
        const username = body.username === undefined ? current.username : requiredText(body.username, "Nama pengguna", 40);
        if (!/^[\p{L}\p{N}._-]+$/u.test(username)) {
          throw Object.assign(new Error("Nama pengguna hanya boleh berisi huruf, angka, titik, garis bawah, dan tanda hubung."), { status: 400 });
        }
        const displayName = body.displayName === undefined ? current.displayName : requiredText(body.displayName, "Nama", 100);
        const role = body.role === undefined ? current.role : body.role;
        if (current.role !== "owner" && !["manager", "cashier"].includes(role)) {
          throw Object.assign(new Error("Peran akun tidak valid."), { status: 400 });
        }
        if (body.pin !== undefined && (typeof body.pin !== "string" || !/^\d{6,12}$/.test(body.pin))) {
          throw Object.assign(new Error("PIN baru harus terdiri dari 6–12 angka."), { status: 400 });
        }
        let storeIds = db.prepare("SELECT store_id AS id FROM user_stores WHERE user_id = ? ORDER BY store_id").all(userId).map((store) => store.id);
        if (body.storeIds !== undefined) {
          if (!Array.isArray(body.storeIds) || body.storeIds.length !== 1
            || body.storeIds.some((id) => !Number.isSafeInteger(id) || id < 1)
            || new Set(body.storeIds).size !== body.storeIds.length) {
            throw Object.assign(new Error("Setiap akun manajer atau kasir harus ditugaskan tepat ke satu cabang."), { status: 400 });
          }
          const stores = db.prepare(`SELECT id FROM stores WHERE active = 1 AND id IN (${body.storeIds.map(() => "?").join(",")})`).all(...body.storeIds);
          if (stores.length !== body.storeIds.length) throw Object.assign(new Error("Ada cabang yang tidak ditemukan atau tidak aktif."), { status: 400 });
          storeIds = body.storeIds;
        }
        const before = { ...current, active: Boolean(current.active), pinConfigured: true, storeIds };
        const updatedAt = new Date().toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          if (body.pin !== undefined) {
            const salt = crypto.randomBytes(16);
            const hash = crypto.scryptSync(body.pin, salt, 64);
            db.prepare(`
              UPDATE users SET username = ?, display_name = ?, role = ?, pin_salt = ?, pin_hash = ?, active = ?, updated_at = ?
              WHERE id = ?
            `).run(username, displayName, role, salt.toString("hex"), hash.toString("hex"), Number(isActive), updatedAt, userId);
            db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
          } else {
            db.prepare(`
              UPDATE users SET username = ?, display_name = ?, role = ?, active = ?, updated_at = ?
              WHERE id = ?
            `).run(username, displayName, role, Number(isActive), updatedAt, userId);
          }
          if (!isActive) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
          if (current.role !== "owner") {
            db.prepare("DELETE FROM user_stores WHERE user_id = ?").run(userId);
            const assignStore = db.prepare("INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)");
            for (const assignedStoreId of storeIds) assignStore.run(userId, assignedStoreId);
          }
          const after = {
            id: userId, username, displayName, role, active: isActive, pinConfigured: true,
            ...(body.pin !== undefined ? { pinChanged: true } : {}), storeIds,
          };
          audit(actor, "update", "user", userId, before, after, null, null, updatedAt);
          db.exec("COMMIT");
          sendJson(res, 200, after);
        } catch (error) {
          db.exec("ROLLBACK");
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Nama pengguna sudah digunakan." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "GET /api/audit-logs") {
        const limitValue = Number(url.searchParams.get("limit") || 100);
        const limit = Number.isSafeInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 200) : 100;
        const logs = db.prepare(`
          SELECT al.id, al.username, al.user_role AS userRole, al.action,
            al.entity_type AS entityType, al.entity_id AS entityId,
            al.store_id AS storeId, s.name AS storeName, al.location_id AS locationId,
            l.name AS locationName, al.before_data AS beforeData, al.after_data AS afterData,
            al.created_at AS createdAt
          FROM audit_logs al LEFT JOIN stores s ON s.id = al.store_id
          LEFT JOIN locations l ON l.id = al.location_id
          ORDER BY al.id DESC LIMIT ?
        `).all(limit);
        sendJson(res, 200, logs.map((log) => ({
          ...log,
          before: log.beforeData ? JSON.parse(log.beforeData) : null,
          after: log.afterData ? JSON.parse(log.afterData) : null,
          beforeData: undefined,
          afterData: undefined,
        })));
        return;
      }
      if (route === "POST /api/stores") {
        const body = await readBody(req);
        const name = requiredText(body.name, "Nama cabang", 100);
        const baseCode = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
          .toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "CABANG";
        let code = baseCode;
        let suffix = 2;
        while (db.prepare("SELECT 1 FROM stores WHERE code = ?").get(code)) {
          code = `${baseCode.slice(0, 16)}-${suffix}`;
          suffix += 1;
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          const createdAt = new Date().toISOString();
          const result = db.prepare("INSERT INTO stores (code, name, created_at) VALUES (?, ?, ?)").run(code, name, createdAt);
          const storeId = Number(result.lastInsertRowid);
          const location = db.prepare(`
            INSERT INTO locations (store_id, name, location_type, created_at) VALUES (?, 'Toko Utama', 'store', ?)
          `).run(storeId, createdAt);
          audit(actor, "create", "store", storeId, null, { code, name }, storeId, Number(location.lastInsertRowid), createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, { id: storeId, code, name, locationId: Number(location.lastInsertRowid) });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return;
      }
      const storeContext = getStoreContext(req, actor, route !== "GET /api/locations" && route !== "POST /api/locations");
      const { storeId, locationId } = storeContext;
      if (route === "GET /api/register") {
        const status = getRegisterStatus(storeId, locationId);
        const summary = status.session ? db.prepare(`
          SELECT COUNT(*) AS salesCount, COALESCE(SUM(total), 0) AS salesTotal
          FROM sales
          WHERE store_id = ? AND location_id = ? AND created_at >= ?
        `).get(storeId, locationId, status.session.openedAt) : null;
        sendJson(res, 200, { ...status, summary });
        return;
      }
      if (route === "POST /api/register/open") {
        const body = await readBody(req);
        const openingCash = body.openingCash === null || body.openingCash === undefined || body.openingCash === ""
          ? null : parseMoney(body.openingCash, "Modal kas awal");
        const createdAt = new Date().toISOString();
        try {
          const result = inTransaction(() => {
            const existing = db.prepare(`
              SELECT id FROM register_sessions WHERE location_id = ? AND closed_at IS NULL
            `).get(locationId);
            if (existing) throw Object.assign(new Error("Kasir di lokasi ini sudah dibuka."), { status: 409 });
            const session = db.prepare(`
              INSERT INTO register_sessions
                (store_id, location_id, opened_by, opened_by_name, opening_cash, opened_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(storeId, locationId, actor.id, actor.displayName, openingCash, createdAt);
            const sessionId = Number(session.lastInsertRowid);
            audit(actor, "open", "register", sessionId, { isOpen: false }, {
              isOpen: true, openingCash, openedAt: createdAt,
            }, storeId, locationId, createdAt);
            return sessionId;
          });
          sendJson(res, 201, { id: result, ...getRegisterStatus(storeId, locationId), summary: { salesCount: 0, salesTotal: 0 } });
        } catch (error) {
          if (error.status === 409 || isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Kasir di lokasi ini sudah dibuka." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "POST /api/register/close") {
        const body = await readBody(req);
        const closingCash = body.closingCash === null || body.closingCash === undefined || body.closingCash === ""
          ? null : parseMoney(body.closingCash, "Uang kas akhir");
        const closedAt = new Date().toISOString();
        const summary = inTransaction(() => {
          const current = db.prepare(`
            SELECT id, opening_cash AS openingCash, opened_at AS openedAt
            FROM register_sessions
            WHERE store_id = ? AND location_id = ? AND closed_at IS NULL
            ORDER BY id DESC LIMIT 1
          `).get(storeId, locationId);
          if (!current) throw Object.assign(new Error("Kasir belum dibuka."), { status: 409 });
          const sales = db.prepare(`
            SELECT COUNT(*) AS salesCount, COALESCE(SUM(total), 0) AS salesTotal,
              COALESCE(SUM(CASE WHEN payment_method = 'Tunai' THEN total ELSE 0 END), 0) AS cashSales
            FROM sales
            WHERE store_id = ? AND location_id = ? AND created_at >= ?
          `).get(storeId, locationId, current.openedAt);
          const result = db.prepare(`
            UPDATE register_sessions SET closed_by = ?, closed_by_name = ?, closing_cash = ?,
              closed_at = ?, sales_count = ?, sales_total = ?
            WHERE id = ? AND closed_at IS NULL
          `).run(actor.id, actor.displayName, closingCash, closedAt, sales.salesCount, sales.salesTotal, current.id);
          if (!result.changes) throw Object.assign(new Error("Sesi kasir sudah ditutup."), { status: 409 });
          const closingSummary = {
            openingCash: current.openingCash, closingCash,
            expectedCash: current.openingCash === null ? null : current.openingCash + sales.cashSales,
            cashSales: sales.cashSales, salesCount: sales.salesCount, salesTotal: sales.salesTotal,
          };
          audit(actor, "close", "register", current.id, { isOpen: true }, {
            isOpen: false, ...closingSummary, closedAt,
          }, storeId, locationId, closedAt);
          return { id: current.id, ...closingSummary, closedAt };
        });
        sendJson(res, 200, { isOpen: false, session: null, summary });
        return;
      }
      if (route === "GET /api/locations") {
        sendJson(res, 200, db.prepare(`
          SELECT id, name, location_type AS type
          FROM locations WHERE store_id = ? AND active = 1 ORDER BY id
        `).all(storeId));
        return;
      }
      if (route === "POST /api/locations") {
        const body = await readBody(req);
        const name = requiredText(body.name, "Nama lokasi", 100);
        const locationType = body.type === undefined ? "warehouse" : body.type;
        if (!["store", "warehouse", "shelf"].includes(locationType)) {
          throw Object.assign(new Error("Jenis lokasi tidak valid."), { status: 400 });
        }
        try {
          const createdAt = new Date().toISOString();
          const locationId = inTransaction(() => {
            const result = db.prepare(`
              INSERT INTO locations (store_id, name, location_type, created_at) VALUES (?, ?, ?, ?)
            `).run(storeId, name, locationType, createdAt);
            const id = Number(result.lastInsertRowid);
            audit(actor, "create", "location", id, null, { name, type: locationType }, storeId, id, createdAt);
            return id;
          });
          sendJson(res, 201, { id: locationId, name, type: locationType });
        } catch (error) {
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Nama lokasi sudah digunakan di cabang ini." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "GET /api/suppliers") {
        sendJson(res, 200, db.prepare("SELECT id, name, phone, contact FROM suppliers ORDER BY name COLLATE NOCASE").all());
        return;
      }
      if (route === "POST /api/suppliers") {
        const body = await readBody(req);
        const name = requiredText(body.name, "Nama supplier", 120);
        const phone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
        const contact = typeof body.contact === "string" ? body.contact.trim().slice(0, 100) : "";
        try {
          const createdAt = new Date().toISOString();
          const id = inTransaction(() => {
            const result = db.prepare(`
              INSERT INTO suppliers (name, phone, contact, created_at) VALUES (?, ?, ?, ?)
            `).run(name, phone, contact, createdAt);
            const supplierId = Number(result.lastInsertRowid);
            audit(actor, "create", "supplier", supplierId, null, { name, phone, contact }, storeId, locationId, createdAt);
            return supplierId;
          });
          sendJson(res, 201, { id, name });
        } catch (error) {
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Supplier sudah terdaftar." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "GET /api/categories") {
        sendJson(res, 200, db.prepare("SELECT id, name FROM categories ORDER BY name COLLATE NOCASE").all());
        return;
      }
      if (route === "POST /api/categories") {
        const body = await readBody(req);
        const name = requiredText(body.name, "Nama kategori", 80);
        try {
          const createdAt = new Date().toISOString();
          const id = inTransaction(() => {
            const result = db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?)").run(name, createdAt);
            const categoryId = Number(result.lastInsertRowid);
            audit(actor, "create", "category", categoryId, null, { name }, storeId, locationId, createdAt);
            return categoryId;
          });
          sendJson(res, 201, { id, name });
        } catch (error) {
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Kategori sudah terdaftar." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "POST /api/receipts") {
        const body = await readBody(req);
        const supplierName = requiredText(body.supplierName, "Nama supplier", 120);
        if (!Number.isSafeInteger(body.productId) || !Number.isSafeInteger(body.quantity) || body.quantity <= 0) {
          throw Object.assign(new Error("Barang dan jumlah penerimaan tidak valid."), { status: 400 });
        }
        const unitCost = parseMoney(body.unitCost, "Harga modal");
        const invoiceNumber = typeof body.invoiceNumber === "string" ? body.invoiceNumber.trim().slice(0, 80) : "";
        db.exec("BEGIN IMMEDIATE");
        try {
          let supplier = db.prepare("SELECT id FROM suppliers WHERE name = ? COLLATE NOCASE").get(supplierName);
          if (!supplier) {
            const result = db.prepare("INSERT INTO suppliers (name, created_at) VALUES (?, ?)").run(supplierName, new Date().toISOString());
            supplier = { id: Number(result.lastInsertRowid) };
          }
          const product = db.prepare("SELECT id FROM products WHERE id = ? AND active = 1").get(body.productId);
          if (!product) throw Object.assign(new Error("Barang tidak ditemukan."), { status: 404 });
          const balance = db.prepare(`
            SELECT stock, cost_price FROM inventory_balances WHERE product_id = ? AND location_id = ?
          `).get(body.productId, locationId) || { stock: 0, cost_price: null };
          const total = unitCost * body.quantity;
          if (!Number.isSafeInteger(total)) throw Object.assign(new Error("Total penerimaan melebihi batas yang didukung."), { status: 400 });
          const createdAt = new Date().toISOString();
          const receiptNumber = `GRN-${createdAt.replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
          const receipt = db.prepare(`
            INSERT INTO purchase_receipts
              (receipt_number, store_id, location_id, supplier_id, invoice_number, total, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(receiptNumber, storeId, locationId, supplier.id, invoiceNumber, total, createdAt);
          db.prepare(`
            INSERT INTO purchase_receipt_items (receipt_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)
          `).run(Number(receipt.lastInsertRowid), body.productId, body.quantity, unitCost);
          const oldCost = balance.cost_price ?? db.prepare("SELECT cost_price FROM products WHERE id = ?").get(body.productId).cost_price;
          const newStock = balance.stock + body.quantity;
          const inventoryValue = balance.stock * oldCost + total;
          if (!Number.isSafeInteger(newStock) || !Number.isSafeInteger(inventoryValue)) {
            throw Object.assign(new Error("Jumlah stok atau nilai persediaan melebihi batas yang didukung."), { status: 400 });
          }
          const averageCost = Math.round(inventoryValue / newStock);
          db.prepare(`
            INSERT INTO inventory_balances (product_id, location_id, stock, min_stock, cost_price, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(product_id, location_id) DO UPDATE SET
              stock = excluded.stock, cost_price = excluded.cost_price, updated_at = excluded.updated_at
          `).run(body.productId, locationId, newStock, averageCost, createdAt);
          db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(body.quantity, body.productId);
          db.prepare(`
            INSERT INTO inventory_movements
              (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
            VALUES (?, ?, ?, 'receipt', ?, ?, ?)
          `).run(body.productId, storeId, locationId, body.quantity, receiptNumber, createdAt);
          audit(actor, "create", "receipt", receiptNumber, {
            stock: balance.stock, costPrice: oldCost,
          }, {
            supplier: supplierName, invoiceNumber, productId: body.productId,
            quantity: body.quantity, unitCost, total, stock: newStock, costPrice: averageCost,
          }, storeId, locationId, createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, { receiptNumber, total, quantity: body.quantity, locationId });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return;
      }
      if (route === "GET /api/receipts") {
        const receipts = db.prepare(`
          SELECT r.receipt_number AS receiptNumber, r.invoice_number AS invoiceNumber,
            r.total, r.created_at AS createdAt, s.name AS supplier,
            l.name AS location, GROUP_CONCAT(p.name || ' × ' || i.quantity, ', ') AS items
          FROM purchase_receipts r
          JOIN suppliers s ON s.id = r.supplier_id
          JOIN locations l ON l.id = r.location_id
          JOIN purchase_receipt_items i ON i.receipt_id = r.id
          JOIN products p ON p.id = i.product_id
          WHERE r.store_id = ?
          GROUP BY r.id ORDER BY r.id DESC LIMIT 20
        `).all(storeId);
        sendJson(res, 200, receipts);
        return;
      }
      if (route === "GET /api/dashboard") {
        const summary = db.prepare(`
          SELECT
            COALESCE((SELECT SUM(total) FROM sales WHERE store_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')), 0) AS today_sales,
            (SELECT COUNT(*) FROM sales WHERE store_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')) AS today_transactions,
            (SELECT COUNT(*) FROM products p JOIN inventory_balances b ON b.product_id = p.id WHERE p.active = 1 AND b.location_id = ?) AS product_count,
            (SELECT COUNT(*) FROM products p JOIN inventory_balances b ON b.product_id = p.id WHERE p.active = 1 AND b.location_id = ? AND b.stock <= b.min_stock) AS low_stock_count,
            COALESCE((SELECT SUM(amount) FROM expenses WHERE store_id = ? AND date(created_at, 'localtime') = date('now', 'localtime')), 0) AS today_expenses
        `).get(storeId, storeId, locationId, locationId, storeId);
        const recentSales = db.prepare(`
          SELECT id, receipt_number, total, payment_method, created_at
          FROM sales WHERE store_id = ? ORDER BY id DESC LIMIT 6
        `).all(storeId);
        sendJson(res, 200, { ...summary, recentSales });
        return;
      }
      if (route === "GET /api/products") {
        const search = (url.searchParams.get("q") || "").trim();
        const today = db.prepare("SELECT date('now', 'localtime') AS today").get().today;
        const products = db.prepare(`
          SELECT p.id, COALESCE(NULLIF(p.barcode, ''), p.sku) AS productCode,
            COALESCE(NULLIF(p.barcode, ''), p.sku) AS sku,
            COALESCE(NULLIF(p.barcode, ''), p.sku) AS barcode, p.name, p.selling_price AS sellingPrice,
            p.promo_discount_percent AS promoDiscountPercent,
            p.promo_buy_quantity AS promoBuyQuantity,
            p.promo_free_quantity AS promoFreeQuantity,
            p.promo_start_date AS promoStartDate, p.promo_end_date AS promoEndDate,
            COALESCE(b.cost_price, p.cost_price) AS costPrice,
            COALESCE(b.stock, 0) AS stock, COALESCE(b.min_stock, p.min_stock) AS minStock,
            COALESCE(c.name, 'Umum') AS category
          FROM products p
          LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = ?
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.active = 1 AND (? = '' OR p.sku LIKE ? OR p.barcode LIKE ? OR p.name LIKE ?
            OR EXISTS (SELECT 1 FROM product_codes pc WHERE pc.product_id = p.id AND pc.code LIKE ?))
          ORDER BY p.name COLLATE NOCASE
        `).all(locationId, search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
          .map((product) => ({
            ...product,
            promoActive: (product.promoDiscountPercent > 0 || product.promoBuyQuantity > 0)
              && (!product.promoStartDate || product.promoStartDate <= today)
              && (!product.promoEndDate || product.promoEndDate >= today),
            productCodes: [],
          }));
        const productById = new Map(products.map((product) => [product.id, product]));
        for (const row of db.prepare(`
          SELECT pc.product_id, pc.code
          FROM product_codes pc JOIN products p ON p.id = pc.product_id
          WHERE p.active = 1 ORDER BY pc.id
        `).all()) {
          productById.get(row.product_id)?.productCodes.push(row.code);
        }
        sendJson(res, 200, products);
        return;
      }
      if (route === "GET /api/members") {
        if (url.searchParams.has("phone")) {
          const phone = normalizeMemberPhone(url.searchParams.get("phone") || "");
          const member = db.prepare(`
            SELECT id, name, phone, points_balance AS pointsBalance
            FROM members WHERE phone = ?
          `).get(phone);
          sendJson(res, 200, member ? { found: true, ...member } : { found: false });
          return;
        }
        const search = (url.searchParams.get("q") || "").trim();
        if (search.length > 120) {
          throw Object.assign(new Error("Pencarian maksimal 120 karakter."), { status: 400 });
        }
        const members = db.prepare(`
          SELECT id, name, phone, points_balance AS pointsBalance,
            created_at AS createdAt, updated_at AS updatedAt
          FROM members
          WHERE ? = '' OR name LIKE ? OR phone LIKE ?
          ORDER BY updated_at DESC, id DESC
          LIMIT 200
        `).all(search, `%${search}%`, `%${search}%`);
        sendJson(res, 200, members);
        return;
      }
      if (route === "POST /api/members") {
        const body = await readBody(req);
        const name = requiredText(body.name, "Nama member", 100);
        const phone = normalizeMemberPhone(body.phone);
        const createdAt = new Date().toISOString();
        try {
          const result = db.prepare(`
            INSERT INTO members (name, phone, created_at, updated_at)
            VALUES (?, ?, ?, ?)
          `).run(name, phone, createdAt, createdAt);
          const id = Number(result.lastInsertRowid);
          audit(actor, "create", "member", id, null, { memberName: name, phone }, storeId, locationId, createdAt);
          sendJson(res, 201, { id, name, phone, pointsBalance: 0, createdAt, updatedAt: createdAt });
        } catch (error) {
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Nomor HP sudah terdaftar sebagai member." });
            return;
          }
          throw error;
        }
        return;
      }
      if (route === "GET /api/sales") {
        const search = (url.searchParams.get("q") || "").trim();
        const from = url.searchParams.get("from") || "";
        const to = url.searchParams.get("to") || "";
        const validDate = (value) => !value || (
          /^\d{4}-\d{2}-\d{2}$/.test(value) && db.prepare("SELECT date(?) = ? AS valid").get(value, value).valid === 1
        );
        if (!validDate(from) || !validDate(to)) {
          throw Object.assign(new Error("Format tanggal pencarian harus YYYY-MM-DD."), { status: 400 });
        }
        if (from && to && from > to) {
          throw Object.assign(new Error("Tanggal mulai tidak boleh melewati tanggal akhir."), { status: 400 });
        }
        if (search.length > 120) {
          throw Object.assign(new Error("Kata pencarian maksimal 120 karakter."), { status: 400 });
        }
        const sales = db.prepare(`
          SELECT s.id, s.receipt_number AS receiptNumber, s.total,
            s.payment_method AS paymentMethod, s.created_at AS createdAt,
            s.customer_type AS customerType, s.member_name AS memberName,
            s.member_phone AS memberPhone, s.points_earned AS pointsEarned,
            COUNT(si.id) AS itemCount
          FROM sales s
          LEFT JOIN sale_items si ON si.sale_id = s.id
          WHERE s.store_id = ?
            AND (? = '' OR s.receipt_number LIKE ? OR s.payment_method LIKE ?
              OR s.member_name LIKE ? OR s.member_phone LIKE ?
              OR EXISTS (
                SELECT 1 FROM sale_items sx
                WHERE sx.sale_id = s.id AND (sx.product_name LIKE ? OR sx.sku LIKE ?)
              ))
            AND (? = '' OR date(s.created_at, 'localtime') >= date(?))
            AND (? = '' OR date(s.created_at, 'localtime') <= date(?))
          GROUP BY s.id
          ORDER BY s.id DESC
          LIMIT 100
        `).all(storeId, search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`,
          from, from, to, to);
        sendJson(res, 200, sales);
        return;
      }
      const saleMatch = url.pathname.match(/^\/api\/sales\/(\d+)$/);
      if (saleMatch && req.method === "GET") {
        const id = Number(saleMatch[1]);
        const sale = db.prepare(`
          SELECT s.id, s.receipt_number AS receiptNumber, s.total,
            s.payment_method AS paymentMethod, s.created_at AS createdAt,
            s.customer_type AS customerType, s.member_name AS memberName,
            s.member_phone AS memberPhone, s.points_earned AS pointsEarned,
            st.name AS storeName, l.name AS locationName
          FROM sales s
          JOIN stores st ON st.id = s.store_id
          LEFT JOIN locations l ON l.id = s.location_id
          WHERE s.id = ? AND s.store_id = ?
        `).get(id, storeId);
        if (!sale) {
          sendJson(res, 404, { error: "Transaksi tidak ditemukan." });
          return;
        }
        sale.items = db.prepare(`
          SELECT product_name AS name, sku, quantity,
            unit_price AS unitPrice, unit_cost AS unitCost,
            discount_amount AS discountAmount, discount_label AS discountLabel,
            quantity * unit_price - discount_amount AS lineTotal
          FROM sale_items WHERE sale_id = ? ORDER BY id
        `).all(id);
        sendJson(res, 200, sale);
        return;
      }
      if (route === "POST /api/products") {
        const body = await readBody(req);
        const productCodes = requiredProductCodes(body);
        const productCode = productCodes[0];
        const name = requiredText(body.name, "Nama barang", 120);
        const sellingPrice = parseMoney(body.sellingPrice, "Harga jual");
        const costPrice = parseMoney(body.costPrice, "Harga modal");
        const promotions = parseProductPromotions(body);
        if (!Number.isSafeInteger(body.stock) || body.stock < 0) throw Object.assign(new Error("Stok awal harus bilangan bulat nol atau lebih."), { status: 400 });
        if (!Number.isSafeInteger(body.minStock) || body.minStock < 0) throw Object.assign(new Error("Batas stok minimum harus bilangan bulat nol atau lebih."), { status: 400 });
        const categoryName = typeof body.category === "string" && body.category.trim()
          ? requiredText(body.category, "Kategori", 80)
          : "Umum";
        db.exec("BEGIN IMMEDIATE");
        try {
          let category = db.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE").get(categoryName);
          if (!category) {
            const result = db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?)").run(categoryName, new Date().toISOString());
            category = { id: Number(result.lastInsertRowid) };
          }
          const matchingProductIds = new Set();
          for (const code of productCodes) {
            for (const row of db.prepare(`
              SELECT DISTINCT product_id FROM product_codes WHERE code = ? COLLATE NOCASE
            `).all(code)) matchingProductIds.add(row.product_id);
          }
          if (matchingProductIds.size > 1) {
            db.exec("ROLLBACK");
            sendJson(res, 409, { error: "Beberapa kode sudah terhubung ke produk yang berbeda. Periksa SKU/barcode di Inventori." });
            return;
          }
          const existingProductId = [...matchingProductIds][0];
          const existingProduct = existingProductId
            ? db.prepare("SELECT id, name, active FROM products WHERE id = ?").get(existingProductId)
            : null;
          if (existingProduct) {
            if (!existingProduct.active) {
              db.exec("ROLLBACK");
              sendJson(res, 409, { error: "Salah satu kode sudah dipakai produk yang diarsipkan." });
              return;
            }
            if (existingProduct.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
              db.exec("ROLLBACK");
              sendJson(res, 409, { error: "Barcode / SKU sudah dipakai produk lain di katalog pusat." });
              return;
            }
            if (db.prepare("SELECT 1 FROM inventory_balances WHERE product_id = ? AND location_id = ?").get(existingProduct.id, locationId)) {
              db.exec("ROLLBACK");
              sendJson(res, 409, { error: "Produk sudah terdaftar di lokasi ini." });
              return;
            }
            const previousProductCodes = db.prepare("SELECT code FROM product_codes WHERE product_id = ? ORDER BY id")
              .all(existingProduct.id).map((row) => row.code);
            const existingCreatedAt = new Date().toISOString();
            const insertCode = db.prepare(`
              INSERT OR IGNORE INTO product_codes (product_id, code, created_at) VALUES (?, ?, ?)
            `);
            for (const code of productCodes) insertCode.run(existingProduct.id, code, existingCreatedAt);
            db.prepare(`
              INSERT INTO inventory_balances (product_id, location_id, stock, min_stock, cost_price, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(existingProduct.id, locationId, body.stock, body.minStock, costPrice, existingCreatedAt);
            db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(body.stock, existingProduct.id);
            if (body.stock > 0) {
              db.prepare(`
                INSERT INTO inventory_movements
                  (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
                VALUES (?, ?, ?, 'initial', ?, 'Stok awal lokasi', ?)
              `).run(existingProduct.id, storeId, locationId, body.stock, existingCreatedAt);
            }
            audit(actor, "assign", "product", existingProduct.id, {
              productCodes: previousProductCodes, stock: 0,
            }, {
              productCodes: db.prepare("SELECT code FROM product_codes WHERE product_id = ? ORDER BY id")
                .all(existingProduct.id).map((row) => row.code), stock: body.stock,
              minStock: body.minStock, costPrice,
            }, storeId, locationId, existingCreatedAt);
            db.exec("COMMIT");
            sendJson(res, 200, {
              id: existingProduct.id,
              existing: true,
              productCodes: db.prepare("SELECT code FROM product_codes WHERE product_id = ? ORDER BY id")
                .all(existingProduct.id).map((row) => row.code),
              message: "Produk sudah ada di katalog pusat; harga katalog dipertahankan beserta pengaturan promo, hanya stok lokasi yang ditambahkan.",
            });
            return;
          }
          const createdAt = new Date().toISOString();
          const result = db.prepare(`
            INSERT INTO products (
              sku, barcode, name, selling_price, cost_price, promo_discount_percent,
              promo_buy_quantity, promo_free_quantity, promo_start_date, promo_end_date,
              category_id, stock, min_stock, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            productCode, productCode, name, sellingPrice, costPrice,
            promotions.promoDiscountPercent, promotions.promoBuyQuantity, promotions.promoFreeQuantity,
            promotions.promoStartDate, promotions.promoEndDate, category.id, body.stock, body.minStock, createdAt,
          );
          const insertCode = db.prepare(`
            INSERT INTO product_codes (product_id, code, created_at) VALUES (?, ?, ?)
          `);
          for (const code of productCodes) insertCode.run(Number(result.lastInsertRowid), code, createdAt);
          db.prepare(`
            INSERT INTO inventory_balances (product_id, location_id, stock, min_stock, cost_price, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(Number(result.lastInsertRowid), locationId, body.stock, body.minStock, costPrice, createdAt);
          if (body.stock > 0) {
            db.prepare(`
              INSERT INTO inventory_movements (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
              VALUES (?, ?, ?, 'initial', ?, 'Stok awal', ?)
            `).run(Number(result.lastInsertRowid), storeId, locationId, body.stock, createdAt);
          }
          audit(actor, "create", "product", Number(result.lastInsertRowid), null, {
            productCodes, name, sellingPrice, costPrice, category: categoryName,
            ...promotions,
            stock: body.stock, minStock: body.minStock,
          }, storeId, locationId, createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, { id: Number(result.lastInsertRowid), productCode, productCodes });
        } catch (error) {
          db.exec("ROLLBACK");
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Barcode / SKU sudah digunakan produk lain." });
            return;
          }
          throw error;
        }
        return;
      }
      const productMatch = url.pathname.match(/^\/api\/products\/(\d+)$/);
      if (productMatch && req.method === "PUT") {
        const id = Number(productMatch[1]);
        const body = await readBody(req);
        const productCodes = requiredProductCodes(body);
        const productCode = productCodes[0];
        const name = requiredText(body.name, "Nama barang", 120);
        const sellingPrice = parseMoney(body.sellingPrice, "Harga jual");
        const costPrice = parseMoney(body.costPrice, "Harga modal");
        const promotions = parseProductPromotions(body);
        if (!Number.isSafeInteger(body.stock) || body.stock < 0) throw Object.assign(new Error("Stok harus bilangan bulat nol atau lebih."), { status: 400 });
        if (!Number.isSafeInteger(body.minStock) || body.minStock < 0) throw Object.assign(new Error("Batas stok minimum harus bilangan bulat nol atau lebih."), { status: 400 });
        const categoryName = typeof body.category === "string" && body.category.trim()
          ? requiredText(body.category, "Kategori", 80)
          : "Umum";
        db.exec("BEGIN IMMEDIATE");
        try {
          const current = db.prepare(`
            SELECT COALESCE(NULLIF(p.barcode, ''), p.sku) AS productCode,
              p.name, p.selling_price AS sellingPrice,
              p.promo_discount_percent AS promoDiscountPercent,
              p.promo_buy_quantity AS promoBuyQuantity,
              p.promo_free_quantity AS promoFreeQuantity,
              p.promo_start_date AS promoStartDate, p.promo_end_date AS promoEndDate,
              COALESCE(c.name, 'Umum') AS category,
              COALESCE(b.stock, 0) AS stock,
              COALESCE(b.min_stock, p.min_stock) AS minStock,
              COALESCE(b.cost_price, p.cost_price) AS costPrice
            FROM products p
            LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = ?
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = ? AND p.active = 1
          `).get(locationId, id);
          if (!current) {
            db.exec("ROLLBACK");
            sendJson(res, 404, { error: "Barang tidak ditemukan." });
            return;
          }
          const currentProductCodes = db.prepare(`
            SELECT code FROM product_codes WHERE product_id = ? ORDER BY id
          `).all(id).map((row) => row.code);
          for (const code of productCodes) {
            const conflictingCode = db.prepare(`
              SELECT 1 FROM product_codes WHERE code = ? COLLATE NOCASE AND product_id <> ? LIMIT 1
            `).get(code, id);
            const wasAlreadyAssigned = currentProductCodes.some((currentCode) =>
              currentCode.toLocaleLowerCase() === code.toLocaleLowerCase());
            if (conflictingCode && !wasAlreadyAssigned) {
              db.exec("ROLLBACK");
              sendJson(res, 409, { error: `Kode "${code}" sudah dipakai produk lain.` });
              return;
            }
          }
          let category = db.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE").get(categoryName);
          if (!category) {
            const result = db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?)").run(categoryName, new Date().toISOString());
            category = { id: Number(result.lastInsertRowid) };
          }
          db.prepare(`
            UPDATE products SET sku = ?, barcode = ?, name = ?, selling_price = ?,
              promo_discount_percent = ?, promo_buy_quantity = ?, promo_free_quantity = ?,
              promo_start_date = ?, promo_end_date = ?, category_id = ?
            WHERE id = ?
          `).run(
            productCode, productCode, name, sellingPrice,
            promotions.promoDiscountPercent, promotions.promoBuyQuantity, promotions.promoFreeQuantity,
            promotions.promoStartDate, promotions.promoEndDate, category.id, id,
          );
          db.prepare("DELETE FROM product_codes WHERE product_id = ?").run(id);
          const insertCode = db.prepare(`
            INSERT INTO product_codes (product_id, code, created_at) VALUES (?, ?, ?)
          `);
          const updatedAt = new Date().toISOString();
          for (const code of productCodes) insertCode.run(id, code, updatedAt);
          db.prepare(`
            INSERT INTO inventory_balances (product_id, location_id, stock, min_stock, cost_price, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id, location_id) DO UPDATE SET
              stock = excluded.stock, min_stock = excluded.min_stock,
              cost_price = excluded.cost_price, updated_at = excluded.updated_at
          `).run(id, locationId, body.stock, body.minStock, costPrice, updatedAt);
          db.prepare("UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM inventory_balances WHERE product_id = ?) WHERE id = ?")
            .run(id, id);
          const delta = body.stock - current.stock;
          if (delta !== 0) {
            db.prepare(`
              INSERT INTO inventory_movements (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
              VALUES (?, ?, ?, 'adjustment', ?, 'Penyesuaian stok', ?)
            `).run(id, storeId, locationId, delta, updatedAt);
          }
          audit(actor, "update", "product", id, {
            productCodes: currentProductCodes, name: current.name,
            sellingPrice: current.sellingPrice, category: current.category,
            promoDiscountPercent: current.promoDiscountPercent,
            promoBuyQuantity: current.promoBuyQuantity, promoFreeQuantity: current.promoFreeQuantity,
            promoStartDate: current.promoStartDate, promoEndDate: current.promoEndDate,
            stock: current.stock, minStock: current.minStock, costPrice: current.costPrice,
          }, {
            productCodes, name, sellingPrice, category: categoryName,
            ...promotions,
            stock: body.stock, minStock: body.minStock, costPrice,
          }, storeId, locationId, updatedAt);
          db.exec("COMMIT");
          sendJson(res, 200, { id, productCode, productCodes });
        } catch (error) {
          db.exec("ROLLBACK");
          if (isUniqueConstraint(error)) {
            sendJson(res, 409, { error: "Barcode / SKU sudah digunakan produk lain." });
            return;
          }
          throw error;
        }
        return;
      }
      if (productMatch && req.method === "DELETE") {
        const id = Number(productMatch[1]);
        const archived = inTransaction(() => {
          const before = db.prepare(`
            SELECT sku, barcode, name, selling_price AS sellingPrice, active
            FROM products WHERE id = ? AND active = 1
          `).get(id);
          if (!before) return false;
          db.prepare("UPDATE products SET active = 0 WHERE id = ? AND active = 1").run(id);
          audit(actor, "archive", "product", id, before, { ...before, active: 0 }, storeId, locationId);
          return true;
        });
        if (!archived) {
          sendJson(res, 404, { error: "Barang tidak ditemukan." });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }
      if (route === "GET /api/stocktakes") {
        const stocktakes = db.prepare(`
          SELECT st.id, st.reference, st.note, st.created_at AS createdAt,
            COUNT(si.id) AS itemCount,
            SUM(CASE WHEN si.quantity_delta != 0 THEN 1 ELSE 0 END) AS changedCount,
            COALESCE(SUM(ABS(si.quantity_delta)), 0) AS adjustmentUnits
          FROM stocktakes st
          JOIN stocktake_items si ON si.stocktake_id = st.id
          WHERE st.store_id = ? AND st.location_id = ?
          GROUP BY st.id ORDER BY st.id DESC LIMIT 20
        `).all(storeId, locationId);
        sendJson(res, 200, stocktakes);
        return;
      }
      const stocktakeMatch = url.pathname.match(/^\/api\/stocktakes\/(\d+)$/);
      if (stocktakeMatch && req.method === "GET") {
        const stocktake = db.prepare(`
          SELECT id, reference, note, created_at AS createdAt
          FROM stocktakes WHERE id = ? AND store_id = ? AND location_id = ?
        `).get(Number(stocktakeMatch[1]), storeId, locationId);
        if (!stocktake) {
          sendJson(res, 404, { error: "Opname stok tidak ditemukan." });
          return;
        }
        const items = db.prepare(`
          SELECT COALESCE(NULLIF(p.barcode, ''), p.sku) AS productCode,
            COALESCE(NULLIF(p.barcode, ''), p.sku) AS sku,
            p.name, si.expected_quantity AS expectedQuantity,
            si.counted_quantity AS countedQuantity, si.quantity_delta AS quantityDelta
          FROM stocktake_items si JOIN products p ON p.id = si.product_id
          WHERE si.stocktake_id = ? ORDER BY p.name COLLATE NOCASE
        `).all(stocktake.id);
        sendJson(res, 200, { ...stocktake, items });
        return;
      }
      if (route === "POST /api/stocktakes") {
        const body = await readBody(req);
        if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 500) {
          throw Object.assign(new Error("Pilih 1–500 barang yang sudah dihitung."), { status: 400 });
        }
        const seen = new Set();
        for (const item of body.items) {
          if (!Number.isSafeInteger(item.productId) || item.productId < 1
            || !Number.isSafeInteger(item.countedQuantity) || item.countedQuantity < 0
            || seen.has(item.productId)) {
            throw Object.assign(new Error("Barang pada opname harus unik dan jumlah hitung berupa bilangan bulat nol atau lebih."), { status: 400 });
          }
          seen.add(item.productId);
        }
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
        db.exec("BEGIN IMMEDIATE");
        try {
          const createdAt = new Date().toISOString();
          const reference = `OPN-${createdAt.replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
          const result = db.prepare(`
            INSERT INTO stocktakes (reference, store_id, location_id, note, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(reference, storeId, locationId, note, createdAt);
          const stocktakeId = Number(result.lastInsertRowid);
          const readProduct = db.prepare(`
            SELECT p.id, p.name, p.stock, p.min_stock, p.cost_price,
              COALESCE(b.stock, 0) AS expected,
              COALESCE(b.min_stock, p.min_stock) AS minStock,
              COALESCE(b.cost_price, p.cost_price) AS costPrice
            FROM products p
            LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = ?
            WHERE p.id = ? AND p.active = 1
          `);
          const saveItem = db.prepare(`
            INSERT INTO stocktake_items
              (stocktake_id, product_id, expected_quantity, counted_quantity, quantity_delta)
            VALUES (?, ?, ?, ?, ?)
          `);
          const saveBalance = db.prepare(`
            INSERT INTO inventory_balances (product_id, location_id, stock, min_stock, cost_price, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(product_id, location_id) DO UPDATE SET
              stock = excluded.stock, updated_at = excluded.updated_at
          `);
          const updateTotalStock = db.prepare(`
            UPDATE products SET stock = (
              SELECT COALESCE(SUM(stock), 0) FROM inventory_balances WHERE product_id = ?
            ) WHERE id = ?
          `);
          const saveMovement = db.prepare(`
            INSERT INTO inventory_movements
              (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
            VALUES (?, ?, ?, 'stocktake', ?, ?, ?)
          `);
          let changedCount = 0;
          let adjustmentUnits = 0;
          const beforeItems = [];
          const afterItems = [];
          for (const item of body.items) {
            const product = readProduct.get(locationId, item.productId);
            if (!product) throw Object.assign(new Error("Ada barang yang tidak ditemukan atau sudah diarsipkan."), { status: 409 });
            const delta = item.countedQuantity - product.expected;
            beforeItems.push({ productId: product.id, name: product.name, stock: product.expected });
            afterItems.push({ productId: product.id, name: product.name, stock: item.countedQuantity, delta });
            saveItem.run(stocktakeId, product.id, product.expected, item.countedQuantity, delta);
            saveBalance.run(product.id, locationId, item.countedQuantity, product.minStock, product.costPrice, createdAt);
            updateTotalStock.run(product.id, product.id);
            if (delta !== 0) {
              saveMovement.run(product.id, storeId, locationId, delta, reference, createdAt);
              changedCount += 1;
              adjustmentUnits += Math.abs(delta);
            }
          }
          audit(actor, "create", "stocktake", reference, { items: beforeItems }, {
            note, itemCount: body.items.length, changedCount, adjustmentUnits, items: afterItems,
          }, storeId, locationId, createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, { id: stocktakeId, reference, itemCount: body.items.length, changedCount, adjustmentUnits, createdAt });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return;
      }
      if (route === "POST /api/sales") {
        const body = await readBody(req);
        if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 100) {
          throw Object.assign(new Error("Keranjang harus berisi 1–100 barang."), { status: 400 });
        }
        const customerType = body.customerType === undefined ? "regular" : body.customerType;
        if (!["regular", "member"].includes(customerType)) {
          throw Object.assign(new Error("Jenis pelanggan tidak valid."), { status: 400 });
        }
        const memberPhone = customerType === "member" ? normalizeMemberPhone(body.memberPhone) : "";
        if (customerType === "member" && body.memberName !== undefined
          && (typeof body.memberName !== "string" || body.memberName.trim().length > 100)) {
          throw Object.assign(new Error("Nama member maksimal 100 karakter."), { status: 400 });
        }
        const paymentMethods = ["Tunai", "QRIS", "Kartu debit", "Transfer"];
        if (!paymentMethods.includes(body.paymentMethod)) {
          throw Object.assign(new Error("Metode pembayaran tidak valid."), { status: 400 });
        }
        const quantities = new Map();
        for (const item of body.items) {
          if (!Number.isSafeInteger(item.productId) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
            throw Object.assign(new Error("Barang atau jumlah pada keranjang tidak valid."), { status: 400 });
          }
          quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          if (!getRegisterStatus(storeId, locationId).isOpen) {
            throw Object.assign(new Error("Kasir sedang ditutup. Buka kasir terlebih dahulu sebelum membuat transaksi."), { status: 409 });
          }
          const today = db.prepare("SELECT date('now', 'localtime') AS today").get().today;
          const lines = [];
          for (const [productId, quantity] of quantities) {
            const product = db.prepare(`
              SELECT p.id, COALESCE(NULLIF(p.barcode, ''), p.sku) AS sku, p.name, p.selling_price,
                p.promo_discount_percent, p.promo_buy_quantity, p.promo_free_quantity,
                p.promo_start_date, p.promo_end_date,
                COALESCE(b.cost_price, p.cost_price) AS cost_price,
                COALESCE(b.stock, 0) AS stock
              FROM products p
              LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.location_id = ?
              WHERE p.id = ? AND p.active = 1
            `).get(locationId, productId);
            if (!product) throw Object.assign(new Error("Ada barang yang sudah tidak tersedia."), { status: 409 });
            if (product.stock < quantity) throw Object.assign(new Error(`Stok ${product.name} tidak mencukupi (tersedia ${product.stock}).`), { status: 409 });
            const promotion = calculateLinePromotion(product, quantity, today);
            lines.push({
              ...product,
              quantity,
              ...promotion,
              lineTotal: product.selling_price * quantity - promotion.discountAmount,
            });
          }
          const subtotal = lines.reduce((sum, item) => sum + item.selling_price * item.quantity, 0);
          const discountTotal = lines.reduce((sum, item) => sum + item.discountAmount, 0);
          const total = subtotal - discountTotal;
          const costTotal = lines.reduce((sum, item) => sum + item.cost_price * item.quantity, 0);
          if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(discountTotal)
            || !Number.isSafeInteger(total) || !Number.isSafeInteger(costTotal)) {
            throw Object.assign(new Error("Total transaksi melebihi batas yang didukung."), { status: 400 });
          }
          const createdAt = new Date().toISOString();
          let member = null;
          let pointsEarned = 0;
          if (customerType === "member") {
            member = db.prepare(`
              SELECT id, name, phone, points_balance AS pointsBalance
              FROM members WHERE phone = ?
            `).get(memberPhone);
            if (!member) {
              const memberName = requiredText(body.memberName, "Nama member", 100);
              const insertedMember = db.prepare(`
                INSERT INTO members (name, phone, created_at, updated_at)
                VALUES (?, ?, ?, ?)
              `).run(memberName, memberPhone, createdAt, createdAt);
              member = {
                id: Number(insertedMember.lastInsertRowid),
                name: memberName,
                phone: memberPhone,
                pointsBalance: 0,
              };
            }
            pointsEarned = Math.floor(total / 10000);
            if (!Number.isSafeInteger(member.pointsBalance + pointsEarned)) {
              throw Object.assign(new Error("Saldo poin member melebihi batas yang didukung."), { status: 400 });
            }
            db.prepare("UPDATE members SET points_balance = points_balance + ?, updated_at = ? WHERE id = ?")
              .run(pointsEarned, createdAt, member.id);
            member.pointsBalance += pointsEarned;
          }
          const receiptNumber = `TRX-${createdAt.replace(/\D/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
          const sale = db.prepare(`
            INSERT INTO sales (
              receipt_number, store_id, total, cost_total, payment_method,
              customer_type, member_id, member_name, member_phone, points_earned,
              location_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            receiptNumber, storeId, total, costTotal, body.paymentMethod,
            customerType, member?.id || null, member?.name || "", member?.phone || "", pointsEarned,
            locationId, createdAt,
          );
          const saleId = Number(sale.lastInsertRowid);
          for (const item of lines) {
            db.prepare(`
                INSERT INTO sale_items (
                  sale_id, product_id, sku, product_name, quantity, unit_price, unit_cost,
                  discount_amount, discount_label
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(
                saleId, item.id, item.sku, item.name, item.quantity,
                item.selling_price, item.cost_price, item.discountAmount, item.discountLabel,
              );
            db.prepare(`
              UPDATE inventory_balances SET stock = stock - ?, updated_at = ?
              WHERE product_id = ? AND location_id = ?
            `).run(item.quantity, createdAt, item.id, locationId);
            db.prepare("UPDATE products SET stock = (SELECT COALESCE(SUM(stock), 0) FROM inventory_balances WHERE product_id = ?) WHERE id = ?")
              .run(item.id, item.id);
            db.prepare(`
              INSERT INTO inventory_movements (product_id, store_id, location_id, movement_type, quantity_delta, note, created_at)
              VALUES (?, ?, ?, 'sale', ?, ?, ?)
            `).run(item.id, storeId, locationId, -item.quantity, receiptNumber, createdAt);
          }
          audit(actor, "create", "sale", receiptNumber, null, {
            subtotal, discountTotal, total, paymentMethod: body.paymentMethod, customerType,
            ...(member ? { memberName: member.name, memberPhone: member.phone, pointsEarned } : {}),
            items: lines.map((item) => ({
              productId: item.id, name: item.name, quantity: item.quantity,
              unitPrice: item.selling_price, discountAmount: item.discountAmount, discountLabel: item.discountLabel,
            })),
          }, storeId, locationId, createdAt);
          db.exec("COMMIT");
          sendJson(res, 201, {
            receiptNumber,
            subtotal,
            discountTotal,
            total,
            paymentMethod: body.paymentMethod,
            customerType,
            memberName: member?.name || "",
            memberPhone: member?.phone || "",
            pointsEarned,
            pointsBalance: member?.pointsBalance || 0,
            createdAt,
            items: lines.map((item) => ({
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.selling_price,
              discountAmount: item.discountAmount,
              discountLabel: item.discountLabel,
              lineTotal: item.lineTotal,
            })),
          });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return;
      }
      if (route === "GET /api/accounting") {
        const period = url.searchParams.get("period") || "month";
        const modifier = localDateModifier(period);
        const sales = db.prepare(`
          SELECT COUNT(*) AS transactions, COALESCE(SUM(total), 0) AS revenue,
            COALESCE(SUM(cost_total), 0) AS cost
          FROM sales WHERE store_id = ? AND date(created_at, 'localtime') >= date('now', 'localtime', ?)
        `).get(storeId, modifier);
        const expenses = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
          WHERE store_id = ? AND date(created_at, 'localtime') >= date('now', 'localtime', ?)
        `).get(storeId, modifier);
        const ledger = db.prepare(`
          SELECT * FROM (
            SELECT receipt_number AS reference, 'Penjualan' AS description,
              total AS amount, 'income' AS type, created_at
            FROM sales WHERE store_id = ? AND date(created_at, 'localtime') >= date('now', 'localtime', ?)
            UNION ALL
            SELECT category AS reference,
              CASE WHEN note = '' THEN category ELSE category || ' — ' || note END AS description,
              amount, 'expense' AS type, created_at
            FROM expenses WHERE store_id = ? AND date(created_at, 'localtime') >= date('now', 'localtime', ?)
          ) ORDER BY created_at DESC LIMIT 50
        `).all(storeId, modifier, storeId, modifier);
        sendJson(res, 200, {
          period,
          transactions: sales.transactions,
          revenue: sales.revenue,
          costOfGoods: sales.cost,
          grossProfit: sales.revenue - sales.cost,
          expenses: expenses.total,
          netProfit: sales.revenue - sales.cost - expenses.total,
          ledger,
        });
        return;
      }
      if (route === "POST /api/expenses") {
        const body = await readBody(req);
        const category = requiredText(body.category, "Kategori", 60);
        const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
        const amount = parseMoney(body.amount, "Jumlah");
        if (amount === 0) throw Object.assign(new Error("Jumlah pengeluaran harus lebih dari nol."), { status: 400 });
        const createdAt = new Date().toISOString();
        const id = inTransaction(() => {
          const result = db.prepare(`
            INSERT INTO expenses (store_id, category, note, amount, created_at) VALUES (?, ?, ?, ?, ?)
          `).run(storeId, category, note, amount, createdAt);
          const expenseId = Number(result.lastInsertRowid);
          audit(actor, "create", "expense", expenseId, null, { category, note, amount }, storeId, locationId, createdAt);
          return expenseId;
        });
        sendJson(res, 201, { id });
        return;
      }
      sendJson(res, 404, { error: "API tidak ditemukan." });
      return;
    }

    serveStatic(req, res, url.pathname);
  }

  const createServer = tlsOptions ? https.createServer.bind(https, tlsOptions) : http.createServer;
  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error) => {
      if (res.headersSent || res.destroyed) return;
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error(error);
      sendJson(res, status, { error: status === 500 ? "Terjadi kesalahan pada server." : error.message });
    });
  });

  return {
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          db.close();
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function resolveServerBindHost({ tlsEnabled = false, configuredHost = process.env.HOST } = {}) {
  if (!tlsEnabled) return "127.0.0.1";
  return configuredHost || "0.0.0.0";
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  let app;
  try {
    app = createRetailServer();
  } catch (error) {
    console.error(`Gagal menyiapkan server: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const tlsEnabled = app.server instanceof https.Server;
  const host = resolveServerBindHost({ tlsEnabled });
  app.server.listen(port, host, () => {
    const address = app.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const protocol = app.server instanceof https.Server ? "https" : "http";
    console.log("Toserba Lokal berjalan.");
    if (tlsEnabled) {
      console.log("Buka alamat berikut di perangkat yang terhubung ke Wi-Fi toko:");
      for (const ip of lanAddresses()) console.log(`  ${protocol}://${ip}:${actualPort}`);
      if (lanAddresses().length === 0) console.log(`  ${protocol}://localhost:${actualPort}`);
    } else {
      console.log("HTTPS tidak dikonfigurasi; server sengaja hanya tersedia dari komputer ini:");
      console.log(`  http://127.0.0.1:${actualPort}`);
      console.log(`  http://localhost:${actualPort}`);
      console.log("Untuk akses LAN, aktifkan TLS_CERT_FILE dan TLS_KEY_FILE. Jangan atur HOST agar server HTTP dapat disebarkan ke LAN.");
    }
    console.log("PIN pemilik dibuat saat pertama kali aplikasi dibuka.");
  });
}

module.exports = { createRetailServer, resolveServerBindHost };
