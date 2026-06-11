const STORAGE_KEY = "pedro-gas-app-v2";
const DATA_VERSION = 2;
const CLOUD_POLL_MS = 6000;
const SALES_STATEMENT_PAGE_SIZE = 25;

const roleLabels = {
  owner: "RNZ",
  partner: "Master",
  driver: "Logística"
};

const roleRank = {
  driver: 1,
  partner: 2,
  owner: 3
};

const appUsers = {
  rnz: {
    password: "rnz013",
    role: "owner",
    name: "RNZ"
  },
  master: {
    password: "mas123",
    role: "partner",
    name: "Master"
  },
  logistica: {
    password: "log123",
    role: "driver",
    name: "Entregador"
  }
};

const orderStatus = {
  open: "Aberto",
  route: "Saiu",
  delivered: "Entregue",
  canceled: "Cancelado"
};

const defaultState = {
  version: DATA_VERSION,
  session: null,
  settings: {
    taxRate: 6,
    merchantDiscount: 8,
    companyData: "",
    supplierName: "",
    supplierPhone: ""
  },
  products: [],
  clients: [],
  orders: []
};

let state = loadState();
let activeReportPeriod = "day";
let salesStatementVisibleCount = SALES_STATEMENT_PAGE_SIZE;
let cloudSaveTimer = null;
let cloudPollTimer = null;
let lastCloudSave = "";
let isSyncingCloud = false;
let hasUnsyncedLocalChanges = false;
let lastRemoteUpdatedAt = "";
let knownOpenOrderIds = new Set((state.orders || []).filter((order) => ["open", "route"].includes(order.status || "open")).map((order) => order.id));

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  maximumFractionDigits: 2
});

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return structuredClone(defaultState);
  try {
    return migrateState(JSON.parse(saved));
  } catch {
    return structuredClone(defaultState);
  }
}

function migrateState(saved) {
  const base = structuredClone(defaultState);
  const migrated = {
    ...base,
    ...saved,
    version: DATA_VERSION,
    settings: { ...base.settings, ...(saved.settings || {}) },
    products: Array.isArray(saved.products) ? saved.products : base.products,
    clients: Array.isArray(saved.clients) ? saved.clients : base.clients,
    orders: Array.isArray(saved.orders) ? saved.orders : base.orders
  };
  migrated.session = normalizeSession(migrated.session);
  return migrated;
}

function normalizeSession(session) {
  if (!session) return null;
  if (session.role === "owner") return { ...session, username: "rnz", name: "RNZ" };
  if (session.role === "partner") return { ...session, username: "master", name: "Master" };
  if (session.role === "driver") return { ...session, username: "logistica", name: "Entregador" };
  return session;
}

function saveState() {
  state.version = DATA_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  hasUnsyncedLocalChanges = true;
  queueCloudSave();
}

function persistStateOnly() {
  state.version = DATA_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatMoney(value) {
  return money.format(Number(value || 0));
}

function byId(id) {
  return document.getElementById(id);
}

function productPrice(product) {
  return Number(findProduct(product)?.price || 0);
}

function productCost(product) {
  return Number(findProduct(product)?.cost || 0);
}

function findProduct(productIdOrName) {
  return state.products.find((product) => product.id === productIdOrName || product.name === productIdOrName);
}

function calculateOrderTotal(product, qty, customerType, manualDiscount) {
  const subtotal = productPrice(product) * Number(qty || 1);
  const merchantDiscount = customerType === "merchant" ? subtotal * (Number(state.settings.merchantDiscount) / 100) : 0;
  return Math.max(0, subtotal - merchantDiscount - Number(manualDiscount || 0));
}

function orderCost(order) {
  return productCost(order.product) * Number(order.qty || 0);
}

function orderProfit(order) {
  const tax = Number(order.total || 0) * (Number(state.settings.taxRate || 0) / 100);
  return Number(order.total || 0) - tax - orderCost(order);
}


function login(user) {
  state.session = normalizeSession({ username: user.username, role: user.role, name: user.name, loggedAt: new Date().toISOString() });
  saveState();
  renderApp();
  startCloudPolling();
  requestNotificationPermission();
  syncWithCloud("login");
}

function logout() {
  stopCloudPolling();
  state.session = null;
  saveState();
  byId("appView").classList.add("hidden");
  byId("loginView").classList.remove("hidden");
  if (window.lucide) window.lucide.createIcons();
}

function applyPermissions() {
  const role = state.session?.role || "driver";
  document.querySelectorAll("[data-min-role]").forEach((el) => {
    const allowed = roleRank[role] >= roleRank[el.dataset.minRole];
    el.classList.toggle("hidden", !allowed);
  });

  document.querySelectorAll(".owner-only").forEach((el) => {
    el.classList.toggle("hidden", role !== "owner");
  });

  const active = document.querySelector(".tab-button.active");
  if (active?.classList.contains("hidden")) {
    openTab("orders");
  }
}

function openTab(tabId) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  if (tabId === "reports") renderReports();
}

function renderApp() {
  byId("loginView").classList.add("hidden");
  byId("appView").classList.remove("hidden");
  byId("activeRole").textContent = `${roleLabels[state.session.role]} • ${state.session.name}`;
  applyPermissions();
  renderAll();
}

function renderAll() {
  renderSummary();
  renderClients();
  renderProducts();
  renderOrders();
  renderDeliveries();
  renderSettings();
  renderSupport();
  renderReports();
  if (window.lucide) window.lucide.createIcons();
}

function todayOrders() {
  const today = new Date().toDateString();
  return state.orders.filter((order) => order.status !== "canceled" && new Date(order.saleDate || order.createdAt).toDateString() === today);
}

function renderSummary() {
  const orders = todayOrders();
  const revenue = orders.reduce((sum, order) => sum + Number(order.total), 0);
  const profit = orders.reduce((sum, order) => sum + orderProfit(order), 0);
  const openDeliveries = state.orders.filter((order) => ["open", "route"].includes(order.status || "open")).length;
  const averageTicket = orders.length ? revenue / orders.length : 0;
  const lowStock = state.products.filter((product) => Number(product.minStock || 0) > 0 && Number(product.stock || 0) <= Number(product.minStock || 0)).length;
  byId("todayRevenue").textContent = formatMoney(revenue);
  byId("todayOrders").textContent = `${orders.length} venda${orders.length === 1 ? "" : "s"} - ${openDeliveries} entrega${openDeliveries === 1 ? "" : "s"} aberta${openDeliveries === 1 ? "" : "s"}`;
  byId("todayProfit").textContent = formatMoney(profit);
  byId("averageTicket").textContent = formatMoney(averageTicket);
  byId("lowStockCount").textContent = String(lowStock);
  byId("pendingDeliveries").textContent = String(openDeliveries);
}


function renderOrders() {
  const list = byId("ordersList");
  if (!state.orders.length) {
    list.innerHTML = '<div class="list-empty">Nenhum pedido cadastrado ainda.</div>';
    return;
  }

  list.innerHTML = [...state.orders]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30)
    .map((order) => `
      <article class="item-card">
        <header>
          <div>
            <h3>${escapeHtml(order.client)}</h3>
            <p>${escapeHtml(order.address)}</p>
          </div>
          <strong class="money">${formatMoney(order.total)}</strong>
        </header>
        <div class="badge-row">
          <span class="badge">${escapeHtml(productLabel(order.product))} x${order.qty}</span>
          <span class="badge">${formatDate(order.saleDate || order.createdAt)}</span>
          <span class="badge">${escapeHtml(order.payment)}</span>
          <span class="badge">${escapeHtml(order.driver || "Sem entregador")}</span>
          <span class="badge ${statusClass(order.status)}">${orderStatus[order.status || "open"]}</span>
          ${order.customerType === "merchant" ? '<span class="badge warning">Comerciante</span>' : ""}
        </div>
        ${order.note ? `<p>${escapeHtml(order.note)}</p>` : ""}
        ${renderOrderActions(order)}
      </article>
    `)
    .join("");
}

function renderDeliveries() {
  const open = state.orders.filter((order) => ["open", "route"].includes(order.status || "open"));
  byId("openDeliveriesCount").textContent = `${open.length} aberta${open.length === 1 ? "" : "s"}`;

  const deliveries = state.orders
    .filter((order) => ["open", "route", "delivered"].includes(order.status || "open"))
    .sort((a, b) => {
      const rank = { route: 0, open: 1, delivered: 2 };
      return (rank[a.status || "open"] - rank[b.status || "open"]) || (new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    })
    .slice(0, 30);
  const list = byId("deliveriesList");
  if (!deliveries.length) {
    list.innerHTML = '<div class="list-empty">Nenhuma entrega registrada.</div>';
    return;
  }

  list.innerHTML = deliveries.map((order) => `
    <article class="item-card">
      <header>
        <div>
          <h3>${escapeHtml(order.client)}</h3>
          <p>${escapeHtml(order.address)}</p>
        </div>
        <span class="badge ${statusClass(order.status)}">${orderStatus[order.status || "open"]}</span>
      </header>
      <div class="badge-row">
        <span class="badge">${escapeHtml(productLabel(order.product))} x${order.qty}</span>
        <span class="badge">${formatDate(order.saleDate || order.createdAt)}</span>
        <span class="badge">${escapeHtml(order.payment)}</span>
        <span class="badge">${escapeHtml(order.driver || "Sem entregador")}</span>
      </div>
      ${order.note ? `<p>${escapeHtml(order.note)}</p>` : ""}
      ${renderOrderActions(order)}
    </article>
  `).join("");
}

function statusClass(status) {
  if (status === "delivered") return "success";
  if (status === "canceled") return "danger";
  if (status === "route") return "warning";
  return "";
}

function renderOrderActions(order) {
  const status = order.status || "open";
  const ownerDelete = state.session?.role === "owner"
    ? `<button class="mini-button danger" type="button" data-order-action="delete" data-order-id="${order.id}">Excluir</button>`
    : "";
  const utilityButtons = `
    ${order.phone ? `<a class="mini-button link" href="${whatsAppLink(order)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}
    ${order.address ? `<a class="mini-button link" href="${mapLink(order.address)}" target="_blank" rel="noopener">Mapa</a>` : ""}
  `;
  if (status === "delivered" || status === "canceled") {
    return `<div class="action-row">${utilityButtons}${ownerDelete}</div>`;
  }
  const cancelButton = state.session?.role === "owner"
    ? `<button class="mini-button danger" type="button" data-order-action="canceled" data-order-id="${order.id}">Cancelar</button>`
    : "";
  return `
    <div class="action-row">
      <button class="mini-button" type="button" data-order-action="route" data-order-id="${order.id}">Saiu</button>
      <button class="mini-button primary" type="button" data-order-action="delivered" data-order-id="${order.id}">Entregue</button>
      ${utilityButtons}
      ${cancelButton}
      ${ownerDelete}
    </div>
  `;
}

function whatsAppLink(order) {
  const digits = String(order.phone || "").replace(/\D/g, "");
  const message = encodeURIComponent(`Pedido Pedro Gas: ${productLabel(order.product)} x${order.qty}. Endereco: ${order.address}`);
  return `https://wa.me/55${digits}?text=${message}`;
}

function mapLink(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}


function productLabel(productIdOrName) {
  return findProduct(productIdOrName)?.name || productIdOrName || "Produto removido";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("pt-BR").format(new Date(value));
}

function renderProducts() {
  byId("productsCount").textContent = String(state.products.length);
  renderProductOptions();

  const list = byId("productsList");
  if (!state.products.length) {
    list.innerHTML = '<div class="list-empty">Nenhum produto cadastrado. Cadastre gás, água, rações e outros itens antes de vender.</div>';
    return;
  }

  list.innerHTML = [...state.products]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((product) => {
      const lowStock = Number(product.minStock || 0) > 0 && Number(product.stock || 0) <= Number(product.minStock || 0);
      return `
        <article class="item-card">
          <header>
            <div>
              <h3>${escapeHtml(product.name)}</h3>
              <p>${escapeHtml(product.category)} • custo ${formatMoney(product.cost)} • venda ${formatMoney(product.price)}</p>
            </div>
            <strong class="money">${Number(product.stock || 0)} un.</strong>
          </header>
          <div class="badge-row">
            <span class="badge ${lowStock ? "warning" : ""}">mínimo ${Number(product.minStock || 0)} un.</span>
            <span class="badge">${lowStock ? "repor estoque" : "estoque ok"}</span>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderProductOptions() {
  const orderSelect = byId("orderProduct");
  const reportSelect = byId("reportProductFilter");
  const options = state.products
    .map((product) => `<option value="${escapeAttr(product.id)}">${escapeHtml(product.name)}</option>`)
    .join("");

  orderSelect.innerHTML = options || '<option value="">Cadastre um produto primeiro</option>';
  reportSelect.innerHTML = `<option value="all">Todos</option>${options}`;
  renderOrderPreview();
}

function renderClients() {
  byId("clientsCount").textContent = String(state.clients.length);
  const datalist = byId("clientNames");
  datalist.innerHTML = state.clients.map((client) => `<option value="${escapeAttr(client.name)}"></option>`).join("");
  renderClientSearchResults();

  const list = byId("clientsList");
  if (!state.clients.length) {
    list.innerHTML = '<div class="list-empty">Nenhum cliente cadastrado ainda.</div>';
    return;
  }

  list.innerHTML = [...state.clients]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((client) => `
      <article class="item-card">
        <header>
          <div>
            <h3>${escapeHtml(client.name)}</h3>
            <p>${escapeHtml(client.address || "Sem endereço")}</p>
          </div>
          <span class="badge ${client.type === "merchant" ? "warning" : ""}">${client.type === "merchant" ? "Comerciante" : "Normal"}</span>
        </header>
        <p>${escapeHtml(client.phone || "Sem telefone")}</p>
      </article>
    `)
    .join("");
}

function renderReports() {
  const orders = filterOrdersByPeriod(activeReportPeriod);
  const revenue = orders.reduce((sum, order) => sum + Number(order.total), 0);
  const taxes = revenue * (Number(state.settings.taxRate) / 100);
  const cost = orders.reduce((sum, order) => sum + productCost(order.product) * Number(order.qty), 0);
  const profit = revenue - taxes - cost;

  byId("reportRevenue").textContent = formatMoney(revenue);
  byId("reportOrders").textContent = String(orders.length);
  byId("reportTaxes").textContent = formatMoney(taxes);
  byId("reportProfit").textContent = formatMoney(profit);
  drawReportChart(orders);
  renderSalesStatement(orders);
}

function renderSalesStatement(orders) {
  const list = byId("salesStatementList");
  const count = byId("salesStatementCount");
  const hint = byId("salesStatementHint");
  if (!list || !count || !hint) return;

  const sortedOrders = [...orders].sort((a, b) => new Date(b.saleDate || b.createdAt) - new Date(a.saleDate || a.createdAt));
  const totalOrders = sortedOrders.length;
  salesStatementVisibleCount = Math.min(Math.max(salesStatementVisibleCount, SALES_STATEMENT_PAGE_SIZE), Math.max(totalOrders, SALES_STATEMENT_PAGE_SIZE));
  const visibleOrders = sortedOrders.slice(0, salesStatementVisibleCount);
  const hasMore = visibleOrders.length < totalOrders;

  count.textContent = `${totalOrders} venda${totalOrders === 1 ? "" : "s"}`;
  hint.textContent = totalOrders
    ? `Mostrando ${visibleOrders.length} de ${totalOrders} venda${totalOrders === 1 ? "" : "s"} no filtro atual.`
    : "Nenhuma venda encontrada no filtro atual.";

  if (!totalOrders) {
    list.innerHTML = '<div class="list-empty">Nenhuma venda encontrada nesse periodo.</div>';
    return;
  }

  list.innerHTML = visibleOrders.map((order) => renderStatementOrder(order)).join("") + (hasMore ? '<div class="list-empty">Role para carregar mais vendas.</div>' : "");
}

function renderStatementOrder(order) {
  const profit = orderProfit(order);
  const status = order.status || "open";
  return `
    <article class="statement-card">
      <header>
        <div>
          <span class="statement-date">${formatDate(order.saleDate || order.createdAt)}</span>
          <h3>${escapeHtml(order.client)}</h3>
          <p>${escapeHtml(order.address || "Sem endereco")}</p>
        </div>
        <strong class="money">${formatMoney(order.total)}</strong>
      </header>
      <div class="statement-meta">
        <span>${escapeHtml(productLabel(order.product))} x${order.qty}</span>
        <span>${escapeHtml(order.payment || "Sem pagamento")}</span>
        <span class="${statusClass(status)}">${orderStatus[status]}</span>
        <span>Lucro ${formatMoney(profit)}</span>
      </div>
      ${order.note ? `<p class="statement-note">${escapeHtml(order.note)}</p>` : ""}
    </article>
  `;
}

function resetReportStatement() {
  salesStatementVisibleCount = SALES_STATEMENT_PAGE_SIZE;
  const list = byId("salesStatementList");
  if (list) list.scrollTop = 0;
  renderReports();
}

function loadMoreStatementRows() {
  const list = byId("salesStatementList");
  if (!list) return;
  const nearBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 80;
  if (!nearBottom) return;
  const totalOrders = filterOrdersByPeriod(activeReportPeriod).length;
  if (salesStatementVisibleCount >= totalOrders) return;
  salesStatementVisibleCount += SALES_STATEMENT_PAGE_SIZE;
  renderReports();
}

function filterOrdersByPeriod(period) {
  const productFilter = byId("reportProductFilter")?.value || "all";
  const paymentFilter = byId("reportPaymentFilter")?.value || "all";
  let start = byId("reportStartDate")?.value ? dateAtStart(byId("reportStartDate").value) : null;
  let end = byId("reportEndDate")?.value ? dateAtEnd(byId("reportEndDate").value) : null;

  if (!start || !end) {
    const range = quickRange(period);
    start = start || range.start;
    end = end || range.end;
  }

  return state.orders.filter((order) => {
    const saleDate = new Date(order.saleDate || order.createdAt);
    const productOk = productFilter === "all" || order.product === productFilter || order.productName === findProduct(productFilter)?.name;
    const paymentOk = paymentFilter === "all" || order.payment === paymentFilter;
    return order.status !== "canceled" && saleDate >= start && saleDate <= end && productOk && paymentOk;
  });
}

function quickRange(period) {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  const days = { day: 1, week: 7, month: 31, year: 366 }[period] || 1;
  start.setDate(end.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function dateAtStart(value) {
  const date = new Date(`${value}T00:00:00`);
  return date;
}

function dateAtEnd(value) {
  const date = new Date(`${value}T23:59:59.999`);
  return date;
}

function drawReportChart(orders) {
  const canvas = byId("reportChart");
  const ctx = canvas.getContext("2d");
  const products = state.products.length ? state.products : [{ id: "none", name: "Sem vendas" }];
  const totals = products.map((product) => ({
    product: product.name,
    total: orders.filter((order) => order.product === product.id || order.productName === product.name).reduce((sum, order) => sum + Number(order.total), 0)
  }));
  const colors = ["#0f6b4f", "#246b98", "#7a5a20", "#b56622"];
  const max = Math.max(1, ...totals.map((item) => item.total));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#dfe6df";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i += 1) {
    const y = (canvas.height / 4) * i;
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(canvas.width - 24, y);
    ctx.stroke();
  }

  totals.forEach((item, index) => {
    const slot = canvas.width / totals.length;
    const barWidth = Math.min(92, slot * 0.48);
    const x = slot * index + (slot - barWidth) / 2;
    const barHeight = (item.total / max) * (canvas.height - 118);
    const y = canvas.height - 62 - barHeight;
    ctx.fillStyle = colors[index % colors.length];
    roundedRect(ctx, x, y, barWidth, barHeight || 4, 12);
    ctx.fill();
    ctx.fillStyle = "#10221c";
    ctx.font = "700 18px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(shortLabel(item.product), x + barWidth / 2, canvas.height - 28);
    ctx.fillStyle = "#65726d";
    ctx.font = "700 16px system-ui";
    ctx.fillText(formatMoney(item.total), x + barWidth / 2, Math.max(24, y - 12));
  });
}

function shortLabel(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 13)}…` : text;
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function renderSettings() {
  const settings = state.settings;
  Object.entries(settings).forEach(([key, value]) => {
    const input = byId(key);
    if (input) input.value = value;
  });
  const version = byId("dataVersion");
  if (version) version.textContent = `dados v${DATA_VERSION}`;
  renderCloudStatus();
}

function supabaseConfig() {
  return window.PEDRO_SUPABASE || {};
}

function isCloudConfigured() {
  const config = supabaseConfig();
  return Boolean(config.url && config.anonKey && !config.url.includes("COLE_AQUI"));
}

function renderCloudStatus(message) {
  const status = byId("cloudStatus");
  const hint = byId("cloudHint");
  const storage = byId("storageStatus");
  if (!status || !hint) {
    if (storage) storage.textContent = isCloudConfigured() ? "Nuvem pronta" : "Local";
    return;
  }
  if (!isCloudConfigured()) {
    status.textContent = "Nao configurada";
    hint.textContent = "Cole a anon public key em supabase-config.js e rode supabase-schema.sql no Supabase.";
    if (storage) storage.textContent = "Local";
    return;
  }
  status.textContent = "Conectada";
  hint.textContent = message || (lastRemoteUpdatedAt ? `Ultima leitura da nuvem: ${formatDateTime(lastRemoteUpdatedAt)}.` : "Os celulares usam a mesma base assim que entram no app.");
  if (storage) storage.textContent = "Nuvem";
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function renderSupport() {
  byId("supportSupplier").textContent = state.settings.supplierName || "Fornecedor não configurado";
  byId("supportPhone").textContent = state.settings.supplierPhone || "Sem contato";
  byId("supportCall").href = `tel:${state.settings.supplierPhone || ""}`;
}

function saveClientFromOrder(order) {
  const existing = state.clients.find((client) => client.name.toLowerCase() === order.client.toLowerCase());
  if (existing) {
    existing.phone = order.phone || existing.phone;
    existing.address = order.address || existing.address;
    existing.type = order.customerType || existing.type;
    existing.updatedAt = new Date().toISOString();
    return;
  }

  state.clients.push({
    id: crypto.randomUUID(),
    name: order.client,
    phone: order.phone,
    address: order.address,
    type: order.customerType,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function wireEvents() {
  byId("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const username = byId("loginInput").value.trim().toLowerCase();
    const password = byId("passwordInput").value;
    const user = appUsers[username];
    if (!user || user.password !== password) {
      alert("Login ou senha inválidos.");
      return;
    }
    login({ username, ...user });
  });

  byId("logoutButton").addEventListener("click", logout);

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.tab));
  });

  document.querySelectorAll("[data-open-tab]").forEach((button) => {
    button.addEventListener("click", () => openTab(button.dataset.openTab));
  });

  byId("orderClient").addEventListener("change", fillOrderFromClient);
  byId("clientSearch").addEventListener("input", renderClientSearchResults);
  byId("clientSearch").addEventListener("focus", renderClientSearchResults);
  ["orderProduct", "orderQty", "orderCustomerType", "orderDiscount"].forEach((id) => {
    byId(id).addEventListener("input", renderOrderPreview);
    byId(id).addEventListener("change", renderOrderPreview);
  });
  byId("orderForm").addEventListener("submit", saveOrder);
  byId("clientForm").addEventListener("submit", saveClient);
  byId("productForm").addEventListener("submit", saveProduct);
  byId("settingsForm").addEventListener("submit", saveSettings);
  byId("clearOrdersButton").addEventListener("click", clearTestOrders);
  byId("resetDataButton").addEventListener("click", resetData);
  byId("exportDataButton").addEventListener("click", exportData);
  byId("importDataInput").addEventListener("change", importData);
  byId("cloudSyncButton").addEventListener("click", () => syncWithCloud("manual"));
  document.addEventListener("click", handleOrderAction);
  document.addEventListener("click", handleClientPick);

  document.querySelectorAll("#reportPeriod button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("#reportPeriod button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      activeReportPeriod = button.dataset.period;
      resetReportStatement();
    });
  });

  ["reportStartDate", "reportEndDate", "reportProductFilter", "reportPaymentFilter"].forEach((id) => {
    byId(id).addEventListener("change", resetReportStatement);
  });
  byId("salesStatementList").addEventListener("scroll", loadMoreStatementRows);
}

function fillOrderFromClient() {
  const client = state.clients.find((item) => item.name.toLowerCase() === byId("orderClient").value.toLowerCase());
  if (!client) return;
  fillOrderFieldsFromClient(client);
}

function fillOrderFieldsFromClient(client) {
  byId("orderClient").value = client.name || "";
  byId("clientSearch").value = client.name || "";
  byId("orderPhone").value = client.phone || "";
  byId("orderAddress").value = client.address || "";
  byId("orderCustomerType").value = client.type || "normal";
  byId("clientSearchResults").classList.add("hidden");
}

function renderClientSearchResults() {
  const results = byId("clientSearchResults");
  if (!results) return;
  const input = byId("clientSearch");
  const query = (input?.value || "").trim().toLowerCase();
  if (!query && document.activeElement !== input) {
    results.classList.add("hidden");
    return;
  }
  const matches = state.clients
    .filter((client) => !query || `${client.name} ${client.phone || ""} ${client.address || ""}`.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .slice(0, 8);

  if (!matches.length) {
    results.innerHTML = '<div class="list-empty">Nenhum cliente encontrado.</div>';
    results.classList.toggle("hidden", !query);
    return;
  }

  results.innerHTML = matches.map((client) => `
    <button class="client-result-button" type="button" data-client-id="${escapeAttr(client.id)}">
      <strong>${escapeHtml(client.name)}</strong>
      <span>${escapeHtml(client.phone || "Sem telefone")} - ${escapeHtml(client.address || "Sem endereco")}</span>
    </button>
  `).join("");
  results.classList.remove("hidden");
}

function handleClientPick(event) {
  const button = event.target.closest("[data-client-id]");
  if (!button) return;
  const client = state.clients.find((item) => item.id === button.dataset.clientId);
  if (client) fillOrderFieldsFromClient(client);
}

function setDefaultSaleDate() {
  const input = byId("orderSaleDate");
  if (!input) return;
  input.value = new Date().toISOString().slice(0, 10);
}

function renderOrderPreview() {
  const product = byId("orderProduct")?.value;
  const qty = Number(byId("orderQty")?.value || 1);
  const customerType = byId("orderCustomerType")?.value || "normal";
  const discount = Number(byId("orderDiscount")?.value || 0);
  const total = product ? calculateOrderTotal(product, qty, customerType, discount) : 0;
  const preview = byId("orderTotalPreview");
  if (preview) preview.textContent = formatMoney(total);
}

function saveOrder(event) {
  event.preventDefault();
  const product = byId("orderProduct").value;
  if (!product || !findProduct(product)) {
    alert("Cadastre um produto antes de salvar a venda.");
    openTab("products");
    return;
  }
  const qty = Number(byId("orderQty").value || 1);
  const customerType = byId("orderCustomerType").value;
  const discount = Number(byId("orderDiscount").value || 0);
  const productItem = findProduct(product);
  const order = {
    id: crypto.randomUUID(),
    client: byId("orderClient").value.trim(),
    phone: byId("orderPhone").value.trim(),
    address: byId("orderAddress").value.trim(),
    product,
    productName: productItem.name,
    qty,
    customerType,
    payment: byId("orderPayment").value,
    driver: byId("orderDriver").value.trim(),
    discount,
    note: byId("orderNote").value.trim(),
    total: calculateOrderTotal(product, qty, customerType, discount),
    status: "open",
    stockRestored: false,
    saleDate: byId("orderSaleDate").value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  state.orders.push(order);
  productItem.stock = Math.max(0, Number(productItem.stock || 0) - qty);
  saveClientFromOrder(order);
  saveState();
  event.target.reset();
  setDefaultSaleDate();
  byId("orderQty").value = 1;
  byId("orderDiscount").value = 0;
  byId("clientSearch").value = "";
  renderOrderPreview();
  renderAll();
  syncWithCloud("order");
}

function handleOrderAction(event) {
  const button = event.target.closest("[data-order-action]");
  if (!button) return;
  const order = state.orders.find((item) => item.id === button.dataset.orderId);
  if (!order) return;
  const nextStatus = button.dataset.orderAction;
  if (nextStatus === "delete") {
    deleteOrder(order);
    return;
  }
  if (nextStatus === "canceled" && !confirm("Cancelar esta venda e devolver o estoque?")) return;
  updateOrderStatus(order, nextStatus);
}

function deleteOrder(order) {
  if (state.session?.role !== "owner") {
    alert("Apenas o dono do projeto pode excluir vendas.");
    return;
  }
  if (!confirm("Excluir esta venda definitivamente?")) return;
  if (!order.stockRestored && order.status !== "canceled") {
    const product = findProduct(order.product);
    if (product) product.stock = Number(product.stock || 0) + Number(order.qty || 0);
  }
  state.orders = state.orders.filter((item) => item.id !== order.id);
  saveState();
  renderAll();
  showAppNotice("Venda excluida e estoque ajustado.");
  syncWithCloud("delete");
}

function updateOrderStatus(order, nextStatus) {
  const current = order.status || "open";
  if (current === "canceled" || current === "delivered") return;
  if (nextStatus === "canceled" && state.session?.role !== "owner") {
    alert("Apenas o dono do projeto pode cancelar/excluir vendas.");
    return;
  }
  order.status = nextStatus;
  order.updatedAt = new Date().toISOString();

  if (nextStatus === "canceled" && !order.stockRestored) {
    const product = findProduct(order.product);
    if (product) product.stock = Number(product.stock || 0) + Number(order.qty || 0);
    order.stockRestored = true;
  }

  saveState();
  renderAll();
  showAppNotice(nextStatus === "delivered" ? "Entrega marcada como entregue." : "Status da entrega atualizado.");
  syncWithCloud("status");
}

function saveProduct(event) {
  event.preventDefault();
  const name = byId("productName").value.trim();
  const existing = state.products.find((product) => product.name.toLowerCase() === name.toLowerCase());
  const payload = {
    name,
    category: byId("productCategory").value,
    price: Number(byId("productPrice").value || 0),
    cost: Number(byId("productCost").value || 0),
    stock: Number(byId("productStock").value || 0),
    minStock: Number(byId("productMinStock").value || 0),
    updatedAt: new Date().toISOString()
  };

  if (existing) Object.assign(existing, payload);
  else state.products.push({ id: crypto.randomUUID(), ...payload, createdAt: new Date().toISOString() });

  saveState();
  event.target.reset();
  byId("productStock").value = 0;
  byId("productMinStock").value = 0;
  byId("productCost").value = 0;
  renderAll();
}

function saveClient(event) {
  event.preventDefault();
  const name = byId("clientName").value.trim();
  const existing = state.clients.find((client) => client.name.toLowerCase() === name.toLowerCase());
  const payload = {
    name,
    phone: byId("clientPhone").value.trim(),
    address: byId("clientAddress").value.trim(),
    type: byId("clientType").value
  };

  if (existing) Object.assign(existing, payload, { updatedAt: new Date().toISOString() });
  else state.clients.push({ id: crypto.randomUUID(), ...payload, createdAt: new Date().toISOString() });

  saveState();
  event.target.reset();
  renderAll();
}

function saveSettings(event) {
  event.preventDefault();
  Object.keys(state.settings).forEach((key) => {
    const input = byId(key);
    if (input) state.settings[key] = input.type === "number" ? Number(input.value) : input.value;
  });
  saveState();
  renderAll();
}

function clearTestOrders() {
  if (!confirm("Limpar todos os pedidos de teste deste aparelho?")) return;
  state.orders = [];
  saveState();
  renderAll();
}

function resetData() {
  if (!confirm("Restaurar dados iniciais do protótipo neste aparelho?")) return;
  state = structuredClone(defaultState);
  saveState();
  renderApp();
}

function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: "Pedro gás, água e ração",
    data: { ...state, session: null, version: DATA_VERSION }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `backup-pedro-gas-${date}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const imported = parsed.data || parsed;
    const migrated = migrateState(imported);
    if (!Array.isArray(migrated.orders) || !Array.isArray(migrated.clients) || !Array.isArray(migrated.products)) {
      throw new Error("Arquivo sem dados validos.");
    }
    if (!confirm("Restaurar este backup neste aparelho? Os dados locais atuais serão substituídos.")) return;
    state = { ...migrated, session: state.session };
    saveState();
    renderAll();
    alert("Backup restaurado com sucesso.");
  } catch {
    alert("Não consegui restaurar este arquivo. Verifique se é um backup JSON do app.");
  } finally {
    event.target.value = "";
  }
}

async function syncWithCloud(reason = "auto") {
  if (!isCloudConfigured() || isSyncingCloud) {
    renderCloudStatus();
    return;
  }

  isSyncingCloud = true;
  renderCloudStatus("Sincronizando dados...");
  try {
    const previousOpenIds = new Set(knownOpenOrderIds);
    const remote = await loadCloudState();
    const remoteState = remote?.data ? migrateState(remote.data) : null;
    const isFirstRemoteRead = !lastRemoteUpdatedAt;
    if (remote?.data && hasBusinessData(remote.data)) {
      const merged = mergeStates(state, remoteState);
      state = { ...merged, session: state.session };
    }
    const shouldUpload = hasUnsyncedLocalChanges || ["manual", "login", "autosave", "order", "status"].includes(reason);
    if (shouldUpload) await saveCloudState();
    state.version = DATA_VERSION;
    persistStateOnly();
    if (remote?.updated_at) lastRemoteUpdatedAt = remote.updated_at;
    updateKnownOpenOrders();
    if (reason === "poll" && !isFirstRemoteRead) notifyNewOpenOrders(previousOpenIds);
    renderCloudStatus(reason === "manual" ? "Sincronizacao concluida." : "Dados sincronizados.");
    renderAll();
  } catch (error) {
    renderCloudStatus("Nuvem pendente. Confira a anon key e se o SQL foi rodado no Supabase.");
  } finally {
    isSyncingCloud = false;
  }
}

function mergeStates(localState, remoteState) {
  const clients = mergeItems(remoteState.clients, localState.clients);
  const orders = mergeItems(remoteState.orders, localState.orders);
  const products = mergeItems(remoteState.products, localState.products);
  return {
    ...localState,
    settings: { ...remoteState.settings, ...localState.settings },
    products,
    clients,
    orders,
    version: DATA_VERSION
  };
}

function mergeItems(remoteItems = [], localItems = []) {
  const items = new Map();
  [...remoteItems, ...localItems].forEach((item) => {
    if (!item?.id) return;
    const current = items.get(item.id);
    if (!current || itemTimestamp(item) >= itemTimestamp(current)) {
      items.set(item.id, item);
    }
  });
  return [...items.values()];
}

function itemTimestamp(item) {
  return new Date(item.updatedAt || item.createdAt || item.saleDate || 0).getTime();
}

function queueCloudSave() {
  if (!isCloudConfigured() || isSyncingCloud) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => syncWithCloud("autosave").catch(() => renderCloudStatus("Alteracao local salva; nuvem pendente.")), 900);
}

async function loadCloudState() {
  const rows = await supabaseFetch("/rest/v1/business_state?id=eq.main&select=data,updated_at", {
    method: "GET"
  });
  return Array.isArray(rows) ? rows[0] : null;
}

async function saveCloudState() {
  const data = { ...state, session: null, version: DATA_VERSION };
  const serialized = JSON.stringify(data);
  if (serialized === lastCloudSave) return;
  await supabaseFetch("/rest/v1/business_state", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ id: "main", data, updated_at: new Date().toISOString() })
  });
  lastCloudSave = serialized;
  hasUnsyncedLocalChanges = false;
}

function hasBusinessData(data) {
  return Boolean(data?.orders?.length || data?.clients?.length || data?.products?.length);
}

function startCloudPolling() {
  if (!isCloudConfigured()) return;
  stopCloudPolling();
  cloudPollTimer = setInterval(() => {
    if (state.session) syncWithCloud("poll");
  }, CLOUD_POLL_MS);
}

function stopCloudPolling() {
  clearInterval(cloudPollTimer);
  cloudPollTimer = null;
}

function updateKnownOpenOrders() {
  knownOpenOrderIds = new Set(
    (state.orders || [])
      .filter((order) => ["open", "route"].includes(order.status || "open"))
      .map((order) => order.id)
  );
}

function notifyNewOpenOrders(previousOpenIds) {
  const newOrders = (state.orders || []).filter((order) => {
    const status = order.status || "open";
    return ["open", "route"].includes(status) && !previousOpenIds.has(order.id);
  });
  if (!newOrders.length) return;
  const latest = newOrders[newOrders.length - 1];
  const message = `Novo pedido para entrega: ${latest.client} - ${productLabel(latest.product)} x${latest.qty}`;
  showAppNotice(message);
  if (state.session?.role === "driver") {
    if (navigator.vibrate) navigator.vibrate([180, 80, 180]);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Novo pedido Pedro Gas", { body: message, tag: latest.id });
    }
  }
}

function showAppNotice(message) {
  const notice = byId("appNotice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.remove("hidden");
  clearTimeout(showAppNotice.timer);
  showAppNotice.timer = setTimeout(() => notice.classList.add("hidden"), 9000);
}

function requestNotificationPermission() {
  if (state.session?.role !== "driver" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

async function supabaseFetch(path, options = {}) {
  const config = supabaseConfig();
  const headers = {
    apikey: config.anonKey,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const response = await fetch(`${config.url}${path}`, {
    ...options,
    headers
  });
  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return null;
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  setDefaultSaleDate();
  if (state.session) {
    renderApp();
    startCloudPolling();
    syncWithCloud("login");
  }
  if (window.lucide) window.lucide.createIcons();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}



