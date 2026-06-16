const STORAGE_KEY = "pedro-gas-app-v2";
const LOCAL_SNAPSHOT_KEY = "pedro-gas-app-snapshots-v1";
const DEVICE_ID_KEY = "pedro-gas-device-id-v1";
const DATA_VERSION = 2;
const CLOUD_POLL_MS = 6000;
const DEVICE_HEARTBEAT_MS = 60000;
const LOCATION_REFRESH_MS = 5 * 60000;
const EMERGENCY_LOCATION_MS = 15000;
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
    companyData: "",
    supplierName: "",
    supplierPhone: ""
  },
  products: [],
  clients: [],
  orders: [],
  devices: [],
  emergencyAlerts: []
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
let lastDeviceHeartbeat = 0;
let lastLocationRefresh = 0;
let lastEmergencyLocationRefresh = 0;
let sirenAudio = null;
let mutedEmergencyId = "";
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
    orders: Array.isArray(saved.orders) ? saved.orders : base.orders,
    devices: Array.isArray(saved.devices) ? saved.devices : base.devices,
    emergencyAlerts: Array.isArray(saved.emergencyAlerts) ? saved.emergencyAlerts : base.emergencyAlerts
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

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function deviceInfo() {
  return {
    userAgent: navigator.userAgent || "Indisponível",
    platform: navigator.platform || "Indisponível",
    language: navigator.language || "Indisponível",
    screen: `${window.screen?.width || 0}x${window.screen?.height || 0}`,
    appWidth: window.innerWidth,
    appHeight: window.innerHeight,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Indisponível",
    online: navigator.onLine
  };
}

function updateCurrentDevice(activity = "ativo") {
  if (!state.session) return;
  const id = getDeviceId();
  const now = new Date().toISOString();
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const existing = devices.find((device) => device.id === id);
  const payload = {
    id,
    login: state.session.username,
    role: state.session.role,
    name: state.session.name,
    activity,
    firstSeenAt: existing?.firstSeenAt || state.session.loggedAt || now,
    lastSeenAt: now,
    location: existing?.location || null,
    info: deviceInfo()
  };
  if (existing) Object.assign(existing, payload);
  else devices.push(payload);
  state.devices = devices;
}

function currentDeviceRecord() {
  const id = getDeviceId();
  return (state.devices || []).find((device) => device.id === id);
}

function setCurrentDeviceLocation(position) {
  updateCurrentDevice("localização");
  const device = currentDeviceRecord();
  if (!device) return;
  device.location = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    updatedAt: new Date().toISOString()
  };
}

function saveState() {
  state.version = DATA_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  saveLocalSnapshot();
  hasUnsyncedLocalChanges = true;
  queueCloudSave();
}

function persistStateOnly() {
  state.version = DATA_VERSION;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  saveLocalSnapshot();
}

function saveLocalSnapshot() {
  try {
    const snapshot = { savedAt: new Date().toISOString(), data: { ...state, session: null, version: DATA_VERSION } };
    const current = JSON.parse(localStorage.getItem(LOCAL_SNAPSHOT_KEY) || "[]");
    const snapshots = [snapshot, ...current].slice(0, 7);
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshots));
  } catch {
    // O app principal continua salvando mesmo se o historico local estiver cheio.
  }
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

function calculateOrderTotal(product, qty, _customerType, manualDiscount) {
  const subtotal = productPrice(product) * Number(qty || 1);
  return Math.max(0, subtotal - Number(manualDiscount || 0));
}

function paymentMethods() {
  return [
    { key: "Pix", inputId: "paymentPix" },
    { key: "Dinheiro", inputId: "paymentCash" },
    { key: "Cartão", inputId: "paymentCard", label: "Cartão" },
    { key: "Fiado", inputId: "paymentCredit" }
  ];
}

function collectPayments(total) {
  const payments = paymentMethods()
    .map((method) => ({
      method: method.key,
      amount: Number(byId(method.inputId)?.value || 0)
    }))
    .filter((payment) => payment.amount > 0);
  const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (!payments.length && total > 0) {
    return { payments: [{ method: "Pix", amount: total }], paid: total };
  }
  return { payments, paid };
}

function paymentLabel(order) {
  return orderPayments(order).map((payment) => `${payment.method}${payment.amount ? ` ${formatMoney(payment.amount)}` : ""}`).join(" + ");
}

function orderPayments(order) {
  return Array.isArray(order.payments) && order.payments.length
    ? order.payments
    : [{ method: order.payment || "Sem pagamento", amount: Number(order.total || 0) }];
}

function orderHasPayment(order, paymentFilter) {
  if (paymentFilter === "all") return true;
  const target = normalizePaymentName(paymentFilter);
  if (normalizePaymentName(order.payment) === target) return true;
  return orderPayments(order).some((payment) => normalizePaymentName(payment.method) === target);
}

function normalizePaymentName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function resetPaymentInputs() {
  paymentMethods().forEach((method) => {
    const input = byId(method.inputId);
    if (input) input.value = "";
  });
  updatePaymentSplitHint();
}

function fillPaymentWithTotal() {
  resetPaymentInputs();
  const total = currentOrderTotal();
  byId("paymentPix").value = total ? total.toFixed(2) : "";
  updatePaymentSplitHint();
}

function currentOrderTotal() {
  const product = byId("orderProduct")?.value;
  const qty = Number(byId("orderQty")?.value || 1);
  const discount = Number(byId("orderDiscount")?.value || 0);
  return product ? calculateOrderTotal(product, qty, "normal", discount) : 0;
}

function updatePaymentSplitHint() {
  const hint = byId("paymentSplitHint");
  if (!hint) return;
  const total = currentOrderTotal();
  const { paid } = collectPayments(total);
  const diff = Number((total - paid).toFixed(2));
  if (!paid) {
    hint.textContent = `Se deixar em branco, o total ${formatMoney(total)} será salvo como Pix.`;
    hint.className = "payment-hint";
  } else if (Math.abs(diff) < 0.01) {
    hint.textContent = `Pagamento fechado: ${formatMoney(paid)}.`;
    hint.className = "payment-hint success";
  } else if (diff > 0) {
    hint.textContent = `Falta distribuir ${formatMoney(diff)}.`;
    hint.className = "payment-hint warning";
  } else {
    hint.textContent = `Pagamento passou ${formatMoney(Math.abs(diff))}.`;
    hint.className = "payment-hint danger";
  }
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
  updateCurrentDevice("login");
  saveState();
  renderApp();
  startCloudPolling();
  requestNotificationPermission();
  syncWithCloud("login");
}

function logout() {
  stopCloudPolling();
  updateCurrentDevice("logout");
  persistStateOnly();
  state.session = null;
  saveState();
  document.body.classList.add("login-mode");
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
  document.body.classList.remove("login-mode");
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
  renderEmergencyOverlay();
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
          <span class="badge">${escapeHtml(paymentLabel(order))}</span>
          <span class="badge">${escapeHtml(order.driver || "Sem entregador")}</span>
          <span class="badge ${statusClass(order.status)}">${orderStatus[order.status || "open"]}</span>
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
        <span class="badge">${escapeHtml(paymentLabel(order))}</span>
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
  const message = encodeURIComponent(`Pedido Pedro Gás: ${productLabel(order.product)} x${order.qty}. Endereço: ${order.address}`);
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
          <span class="badge">Cliente</span>
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
  renderWeeklyClose();
  drawReportChart(orders);
  renderSalesStatement();
}

function renderWeeklyClose() {
  const range = currentWeekRange();
  const weeklyOrders = state.orders.filter((order) => {
    const saleDate = new Date(order.saleDate || order.createdAt);
    return order.status !== "canceled" && saleDate >= range.start && saleDate <= range.end;
  });
  const totals = paymentTotals(weeklyOrders);
  const pix = totals.pix || 0;
  const card = totals.cartao || 0;
  const cash = totals.dinheiro || 0;
  byId("weeklyPix").textContent = formatMoney(pix);
  byId("weeklyCard").textContent = formatMoney(card);
  byId("weeklyCash").textContent = formatMoney(cash);
  byId("weeklyReceived").textContent = formatMoney(pix + card + cash);
  byId("weeklyCloseRange").textContent = `${formatDate(range.start)} a ${formatDate(range.end)}`;
}

function paymentTotals(orders) {
  return orders.reduce((totals, order) => {
    orderPayments(order).forEach((payment) => {
      const key = normalizePaymentName(payment.method);
      totals[key] = (totals[key] || 0) + Number(payment.amount || 0);
    });
    return totals;
  }, {});
}

function currentWeekRange() {
  const now = new Date();
  const start = new Date(now);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function renderSalesStatement() {
  const list = byId("salesStatementList");
  const count = byId("salesStatementCount");
  const hint = byId("salesStatementHint");
  if (!list || !count || !hint) return;

  const sortedOrders = filterOrdersForStatement();
  const totalOrders = sortedOrders.length;
  salesStatementVisibleCount = Math.min(Math.max(salesStatementVisibleCount, SALES_STATEMENT_PAGE_SIZE), Math.max(totalOrders, SALES_STATEMENT_PAGE_SIZE));
  const visibleOrders = sortedOrders.slice(0, salesStatementVisibleCount);
  const hasMore = visibleOrders.length < totalOrders;

  count.textContent = `${totalOrders} venda${totalOrders === 1 ? "" : "s"}`;
  hint.textContent = totalOrders
    ? `Mostrando ${visibleOrders.length} de ${totalOrders} venda${totalOrders === 1 ? "" : "s"}, com Hoje e Ontem no topo.`
    : "Nenhuma venda encontrada no extrato.";

  if (!totalOrders) {
    list.innerHTML = '<div class="list-empty">Nenhuma venda encontrada no extrato.</div>';
    return;
  }

  list.innerHTML = renderStatementGroups(visibleOrders) + (hasMore ? '<div class="list-empty">Role para carregar mais vendas.</div>' : "");
}

function filterOrdersForStatement() {
  const productFilter = byId("reportProductFilter")?.value || "all";
  const paymentFilter = byId("reportPaymentFilter")?.value || "all";
  const start = byId("reportStartDate")?.value ? dateAtStart(byId("reportStartDate").value) : null;
  const end = byId("reportEndDate")?.value ? dateAtEnd(byId("reportEndDate").value) : null;

  return state.orders
    .filter((order) => {
      const saleDate = new Date(order.saleDate || order.createdAt);
      const productOk = productFilter === "all" || order.product === productFilter || order.productName === findProduct(productFilter)?.name;
      const paymentOk = orderHasPayment(order, paymentFilter);
      const startOk = !start || saleDate >= start;
      const endOk = !end || saleDate <= end;
      return order.status !== "canceled" && productOk && paymentOk && startOk && endOk;
    })
    .sort((a, b) => new Date(b.saleDate || b.createdAt) - new Date(a.saleDate || a.createdAt));
}

function renderStatementGroups(orders) {
  let currentGroup = "";
  return orders.map((order) => {
    const group = statementDateGroup(order.saleDate || order.createdAt);
    const heading = group !== currentGroup ? `<div class="statement-day">${escapeHtml(group)}</div>` : "";
    currentGroup = group;
    return `${heading}${renderStatementOrder(order)}`;
  }).join("");
}

function renderStatementOrder(order) {
  const status = order.status || "open";
  return `
    <article class="statement-card">
      <span class="statement-date">${formatDate(order.saleDate || order.createdAt)}</span>
      <div class="statement-main">
        <div class="statement-info">
          <h3>${escapeHtml(order.client)}</h3>
          <p>${escapeHtml(order.address || "Sem endereço")}</p>
        </div>
        <strong class="money">${formatMoney(order.total)}</strong>
      </div>
      <div class="statement-meta">
        <span>${escapeHtml(productLabel(order.product))} x${order.qty}</span>
        <span>${escapeHtml(paymentLabel(order))}</span>
        <span class="${statusClass(status)}">${orderStatus[status]}</span>
      </div>
      ${order.note ? `<p class="statement-note">${escapeHtml(order.note)}</p>` : ""}
    </article>
  `;
}

function statementDateGroup(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Hoje";
  if (date.toDateString() === yesterday.toDateString()) return "Ontem";
  return formatDate(value);
}

function statementRows() {
  return filterOrdersForStatement().map((order) => ({
    data: formatDate(order.saleDate || order.createdAt),
    grupo: statementDateGroup(order.saleDate || order.createdAt),
    nome: order.client || "",
    endereco: order.address || "",
    produto: productLabel(order.product),
    quantidade: Number(order.qty || 0),
    pagamento: paymentLabel(order),
    status: orderStatus[order.status || "open"] || "",
    valor: Number(order.total || 0),
    observacao: order.note || ""
  }));
}

function exportStatementCsv() {
  const rows = statementRows();
  if (!rows.length) {
    alert("Não há vendas no extrato atual para exportar.");
    return;
  }
  const headers = ["data", "grupo", "nome", "endereco", "produto", "quantidade", "pagamento", "status", "valor", "observacao"];
  const csv = [headers.join(";")]
    .concat(rows.map((row) => headers.map((key) => csvCell(row[key])).join(";")))
    .join("\n");
  downloadFile(`extrato-vendas-${fileDate()}.csv`, "\ufeff" + csv, "text/csv;charset=utf-8");
}

function exportStatementJson() {
  const rows = statementRows();
  if (!rows.length) {
    alert("Não há vendas no extrato atual para exportar.");
    return;
  }
  downloadFile(
    `extrato-vendas-${fileDate()}.json`,
    JSON.stringify({ exportedAt: new Date().toISOString(), app: "Pedro gas, agua e racao", rows }, null, 2),
    "application/json"
  );
}

function exportStatementPdf() {
  const rows = statementRows();
  if (!rows.length) {
    alert("Não há vendas no extrato atual para exportar.");
    return;
  }
  const existing = document.querySelector(".print-statement");
  if (existing) existing.remove();
  const printable = document.createElement("section");
  printable.className = "print-statement";
  printable.innerHTML = `
    <h1>Extrato de vendas</h1>
    <p>Pedro gas, agua e racao - gerado em ${formatDateTime(new Date().toISOString())}</p>
    <table>
      <thead>
        <tr>
          <th>Data</th>
          <th>Nome</th>
          <th>Endereço</th>
          <th>Produto</th>
          <th>Pagamento</th>
          <th>Status</th>
          <th>Valor</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.data)}</td>
            <td>${escapeHtml(row.nome)}</td>
            <td>${escapeHtml(row.endereco)}</td>
            <td>${escapeHtml(row.produto)} x${row.quantidade}</td>
            <td>${escapeHtml(row.pagamento)}</td>
            <td>${escapeHtml(row.status)}</td>
            <td>${formatMoney(row.valor)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  document.body.appendChild(printable);
  window.print();
}

function csvCell(value) {
  const text = String(value ?? "").replace(/"/g, '""');
  return `"${text}"`;
}

function fileDate() {
  return new Date().toISOString().slice(0, 10);
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  const totalOrders = filterOrdersForStatement().length;
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
    const paymentOk = orderHasPayment(order, paymentFilter);
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
  renderDeviceSecurity();
}

function renderDeviceSecurity() {
  const list = byId("deviceList");
  const count = byId("deviceCount");
  if (!list || !count) return;
  const devices = [...(state.devices || [])].sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  count.textContent = String(devices.length);
  if (!devices.length) {
    list.innerHTML = '<div class="list-empty">Nenhum dispositivo registrado ainda.</div>';
    return;
  }
  const currentId = getDeviceId();
  list.innerHTML = devices.map((device) => {
    const recent = Date.now() - new Date(device.lastSeenAt || 0).getTime() < 10 * 60 * 1000;
    const info = device.info || {};
    const location = device.location;
    const label = roleLabels[device.role] || device.role || "Perfil";
    return `
      <article class="device-card ${device.id === currentId ? "current" : ""}">
        <header>
          <div>
            <h3>${escapeHtml(device.name || device.login || "Dispositivo")}</h3>
            <p>${escapeHtml(label)} - login ${escapeHtml(device.login || "desconhecido")}</p>
          </div>
          <span class="badge ${recent ? "success" : ""}">${recent ? "Ativo" : "Inativo"}</span>
        </header>
        <div class="device-grid">
          <span><strong>ID</strong>${escapeHtml(shortDeviceId(device.id))}${device.id === currentId ? " (este)" : ""}</span>
          <span><strong>Primeiro acesso</strong>${escapeHtml(formatDateTime(device.firstSeenAt || device.lastSeenAt))}</span>
          <span><strong>Ultima atividade</strong>${escapeHtml(formatDateTime(device.lastSeenAt))}</span>
          <span><strong>Atividade</strong>${escapeHtml(device.activity || "ativo")}</span>
          <span><strong>Sistema</strong>${escapeHtml(info.platform || "Indisponível")}</span>
          <span><strong>Tela</strong>${escapeHtml(info.screen || "Indisponível")}</span>
          <span><strong>Idioma</strong>${escapeHtml(info.language || "Indisponível")}</span>
          <span><strong>Fuso</strong>${escapeHtml(info.timezone || "Indisponível")}</span>
        </div>
        ${location ? `
          <div class="device-location">
            <div>
              <strong>Localização</strong>
              <span>${escapeHtml(Number(location.lat).toFixed(6))}, ${escapeHtml(Number(location.lng).toFixed(6))}</span>
              <span>Precisão aproximada: ${Math.round(Number(location.accuracy || 0))} m - ${escapeHtml(formatDateTime(location.updatedAt))}</span>
            </div>
            <a class="mini-button link" href="${locationMapLink(location)}" target="_blank" rel="noopener">Mapa</a>
          </div>
        ` : '<p class="device-agent">Localização ainda não autorizada neste dispositivo.</p>'}
        <p class="device-agent">${escapeHtml(info.userAgent || "Navegador indisponível")}</p>
      </article>
    `;
  }).join("");
  updateLocationStatus();
}

function shortDeviceId(id) {
  const text = String(id || "");
  return text ? `${text.slice(0, 8)}...${text.slice(-4)}` : "sem id";
}

function updateLocationStatus() {
  const status = byId("locationStatus");
  if (!status) return;
  const location = currentDeviceRecord()?.location;
  if (location?.updatedAt) {
    status.textContent = `Última localização enviada: ${formatDateTime(location.updatedAt)}.`;
    return;
  }
  status.textContent = "Autorize para RNZ ver a última localização deste dispositivo.";
}

function requestCurrentLocation(manual = true) {
  if (!("geolocation" in navigator)) {
    if (manual) alert("Este aparelho/navegador não oferece localização para o app.");
    updateLocationStatus();
    return Promise.resolve(false);
  }
  if (manual) showAppNotice("Solicitando permissão de localização do aparelho...");
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCurrentDeviceLocation(position);
        lastLocationRefresh = Date.now();
        saveState();
        renderAll();
        syncWithCloud("location");
        if (manual) showAppNotice("Localização atualizada para segurança.");
        resolve(true);
      },
      () => {
        if (manual) alert("Localização não autorizada. Ative a permissão de localização do app no Android/iPhone.");
        updateLocationStatus();
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

async function refreshLocationIfAllowed() {
  if (!state.session || !("geolocation" in navigator)) return;
  if (Date.now() - lastLocationRefresh < LOCATION_REFRESH_MS) return;
  try {
    if (navigator.permissions?.query) {
      const permission = await navigator.permissions.query({ name: "geolocation" });
      if (permission.state !== "granted") return;
    } else if (!currentDeviceRecord()?.location) {
      return;
    }
    await requestCurrentLocation(false);
  } catch {
    // Se o navegador não permitir consultar permissão, mantemos apenas a atualização manual.
  }
}

function locationMapLink(location) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${location.lat},${location.lng}`)}`;
}

function activeEmergencyAlert() {
  return [...(state.emergencyAlerts || [])]
    .filter((alert) => alert.active)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
}

function currentDeviceEmergency() {
  const deviceId = getDeviceId();
  return (state.emergencyAlerts || []).find((alert) => alert.active && alert.deviceId === deviceId);
}

async function triggerEmergencyAlert() {
  if (!state.session) return;
  if (!confirm("Acionar alerta de emergência para todos os dispositivos conectados?")) return;
  updateCurrentDevice("emergência");
  const now = new Date().toISOString();
  const alert = {
    id: crypto.randomUUID(),
    active: true,
    createdAt: now,
    updatedAt: now,
    deviceId: getDeviceId(),
    triggeredBy: {
      login: state.session.username,
      role: state.session.role,
      name: state.session.name
    },
    location: null,
    locationTrail: []
  };
  state.emergencyAlerts = [alert, ...(state.emergencyAlerts || [])].slice(0, 20);
  mutedEmergencyId = "";
  saveState();
  renderEmergencyOverlay();
  startEmergencySiren(alert.id);
  await updateEmergencyLocation(true);
  syncWithCloud("emergency");
}

function resolveEmergencyAlert() {
  const alert = activeEmergencyAlert();
  if (!alert) return;
  if (!confirm("Encerrar o alerta de emergência para todos os dispositivos?")) return;
  alert.active = false;
  alert.resolvedAt = new Date().toISOString();
  alert.resolvedBy = state.session ? { login: state.session.username, name: state.session.name, role: state.session.role } : null;
  alert.updatedAt = new Date().toISOString();
  stopEmergencySiren();
  saveState();
  renderEmergencyOverlay();
  syncWithCloud("emergency");
}

function renderEmergencyOverlay() {
  const overlay = byId("emergencyOverlay");
  if (!overlay) return;
  const alert = activeEmergencyAlert();
  if (!alert) {
    overlay.classList.add("hidden");
    stopEmergencySiren();
    document.body.classList.remove("emergency-mode");
    return;
  }
  document.body.classList.add("emergency-mode");
  overlay.classList.remove("hidden");
  const who = alert.triggeredBy?.name || alert.triggeredBy?.login || "Dispositivo";
  byId("emergencyMessage").textContent = `${who} acionou o alerta.`;
  const location = alert.location;
  byId("emergencyDetails").innerHTML = `
    <span><strong>Perfil</strong>${escapeHtml(roleLabels[alert.triggeredBy?.role] || alert.triggeredBy?.role || "Indisponível")}</span>
    <span><strong>Início</strong>${escapeHtml(formatDateTime(alert.createdAt))}</span>
    <span><strong>Última atualização</strong>${escapeHtml(formatDateTime(alert.updatedAt))}</span>
    <span><strong>Dispositivo</strong>${escapeHtml(shortDeviceId(alert.deviceId))}</span>
    <span><strong>Localização</strong>${location ? `${escapeHtml(Number(location.lat).toFixed(6))}, ${escapeHtml(Number(location.lng).toFixed(6))}` : "Aguardando permissão/localização"}</span>
    <span><strong>Precisão</strong>${location?.accuracy ? `${Math.round(Number(location.accuracy))} m` : "Indisponível"}</span>
  `;
  const map = byId("emergencyMapLink");
  if (location) {
    map.href = locationMapLink(location);
    map.classList.remove("disabled");
  } else {
    map.href = "#";
    map.classList.add("disabled");
  }
  if (alert.id !== mutedEmergencyId) startEmergencySiren(alert.id);
}

function setEmergencyLocation(position) {
  const alert = currentDeviceEmergency();
  if (!alert) return;
  const location = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    updatedAt: new Date().toISOString()
  };
  alert.location = location;
  alert.locationTrail = [location, ...(alert.locationTrail || [])].slice(0, 30);
  alert.updatedAt = location.updatedAt;
}

function updateEmergencyLocation(manual = false) {
  if (!currentDeviceEmergency() || !("geolocation" in navigator)) return Promise.resolve(false);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setEmergencyLocation(position);
        setCurrentDeviceLocation(position);
        lastEmergencyLocationRefresh = Date.now();
        saveState();
        renderEmergencyOverlay();
        syncWithCloud("emergency");
        resolve(true);
      },
      () => {
        if (manual) showAppNotice("Alerta enviado, mas a localização não foi autorizada neste aparelho.");
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  });
}

function refreshEmergencyLocationIfNeeded() {
  if (!currentDeviceEmergency()) return;
  if (Date.now() - lastEmergencyLocationRefresh < EMERGENCY_LOCATION_MS) return;
  updateEmergencyLocation(false);
}

function startEmergencySiren(alertId) {
  if (mutedEmergencyId === alertId || sirenAudio) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(720, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    const interval = setInterval(() => {
      const t = ctx.currentTime;
      oscillator.frequency.cancelScheduledValues(t);
      oscillator.frequency.setValueAtTime(620, t);
      oscillator.frequency.linearRampToValueAtTime(1180, t + 0.35);
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(0.02, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.08);
      gain.gain.linearRampToValueAtTime(0.02, t + 0.5);
    }, 520);
    sirenAudio = { ctx, oscillator, gain, interval };
  } catch {
    sirenAudio = null;
  }
}

function stopEmergencySiren() {
  if (!sirenAudio) return;
  clearInterval(sirenAudio.interval);
  try {
    sirenAudio.oscillator.stop();
    sirenAudio.ctx.close();
  } catch {}
  sirenAudio = null;
}

function silenceEmergencySiren() {
  const alert = activeEmergencyAlert();
  if (alert) mutedEmergencyId = alert.id;
  stopEmergencySiren();
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
    status.textContent = "Não configurada";
    hint.textContent = "Cole a anon public key em supabase-config.js e rode supabase-schema.sql no Supabase.";
    if (storage) storage.textContent = "Local";
    return;
  }
  status.textContent = "Conectada";
  hint.textContent = message || (lastRemoteUpdatedAt ? `Ultima leitura da nuvem: ${formatDateTime(lastRemoteUpdatedAt)}.` : "Os celulares usam a mesma base assim que entram no app.");
  if (storage) storage.textContent = "Nuvem";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Indisponível";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function renderSupport() {
  byId("supportSupplier").textContent = state.settings.supplierName || "Fornecedor não configurado";
  byId("supportPhone").textContent = state.settings.supplierPhone || "Sem contato";
  byId("supportCall").href = `tel:${state.settings.supplierPhone || ""}`;
  updateLocationStatus();
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
  ["orderProduct", "orderQty", "orderDiscount"].forEach((id) => {
    byId(id).addEventListener("input", renderOrderPreview);
    byId(id).addEventListener("change", renderOrderPreview);
  });
  paymentMethods().forEach((method) => {
    byId(method.inputId).addEventListener("input", updatePaymentSplitHint);
  });
  byId("fillPaymentButton").addEventListener("click", fillPaymentWithTotal);
  byId("orderForm").addEventListener("submit", saveOrder);
  byId("clientForm").addEventListener("submit", saveClient);
  byId("productForm").addEventListener("submit", saveProduct);
  byId("settingsForm").addEventListener("submit", saveSettings);
  byId("clearOrdersButton").addEventListener("click", clearTestOrders);
  byId("resetDataButton").addEventListener("click", resetData);
  byId("exportDataButton").addEventListener("click", exportData);
  byId("importDataInput").addEventListener("change", importData);
  byId("cloudSyncButton").addEventListener("click", () => syncWithCloud("manual"));
  byId("exportStatementPdfButton").addEventListener("click", exportStatementPdf);
  byId("exportStatementCsvButton").addEventListener("click", exportStatementCsv);
  byId("exportStatementJsonButton").addEventListener("click", exportStatementJson);
  byId("updateLocationButton").addEventListener("click", () => requestCurrentLocation(true));
  byId("panicButton").addEventListener("click", triggerEmergencyAlert);
  byId("resolveEmergencyButton").addEventListener("click", resolveEmergencyAlert);
  byId("stopSirenButton").addEventListener("click", silenceEmergencySiren);
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
  window.addEventListener("online", () => {
    if (state.session) syncWithCloud("online");
  });
  window.addEventListener("focus", () => {
    if (state.session) syncWithCloud("focus");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.session) syncWithCloud("focus");
  });
  window.addEventListener("beforeunload", () => {
    if (state.session) persistStateOnly();
  });
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
      <span>${escapeHtml(client.phone || "Sem telefone")} - ${escapeHtml(client.address || "Sem endereço")}</span>
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
  const total = currentOrderTotal();
  const preview = byId("orderTotalPreview");
  if (preview) preview.textContent = formatMoney(total);
  updatePaymentSplitHint();
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
  const customerType = "normal";
  const discount = Number(byId("orderDiscount").value || 0);
  const productItem = findProduct(product);
  const total = calculateOrderTotal(product, qty, customerType, discount);
  const { payments, paid } = collectPayments(total);
  if (Math.abs(Number((paid - total).toFixed(2))) >= 0.01) {
    alert(`O pagamento dividido precisa fechar o total da venda (${formatMoney(total)}). Atualmente está em ${formatMoney(paid)}.`);
    return;
  }
  const order = {
    id: crypto.randomUUID(),
    client: byId("orderClient").value.trim(),
    phone: byId("orderPhone").value.trim(),
    address: byId("orderAddress").value.trim(),
    product,
    productName: productItem.name,
    qty,
    customerType,
    payment: payments.map((payment) => payment.method).join(" + "),
    payments,
    driver: byId("orderDriver").value.trim(),
    discount,
    note: byId("orderNote").value.trim(),
    total,
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
  resetPaymentInputs();
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
    type: "normal"
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
    const previousEmergencyIds = new Set((state.emergencyAlerts || []).filter((alert) => alert.active).map((alert) => alert.id));
    const remote = await loadCloudState();
    const remoteState = remote?.data ? migrateState(remote.data) : null;
    const isFirstRemoteRead = !lastRemoteUpdatedAt;
    if (remote?.data && hasBusinessData(remote.data)) {
      const merged = mergeStates(state, remoteState);
      state = { ...merged, session: state.session };
    }
    updateCurrentDevice(reason);
    const shouldUpload = hasUnsyncedLocalChanges || ["manual", "login", "autosave", "order", "status", "delete", "online", "focus", "heartbeat", "location", "emergency"].includes(reason);
    if (shouldUpload) await saveCloudState();
    state.version = DATA_VERSION;
    persistStateOnly();
    if (remote?.updated_at) lastRemoteUpdatedAt = remote.updated_at;
    updateKnownOpenOrders();
    if (reason === "poll" && !isFirstRemoteRead) notifyNewOpenOrders(previousOpenIds);
    if (reason === "poll" && !isFirstRemoteRead) notifyNewEmergencyAlerts(previousEmergencyIds);
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
  const devices = mergeItems(remoteState.devices, localState.devices);
  const emergencyAlerts = mergeItems(remoteState.emergencyAlerts, localState.emergencyAlerts);
  return {
    ...localState,
    settings: { ...remoteState.settings, ...localState.settings },
    products,
    clients,
    orders,
    devices,
    emergencyAlerts,
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
  return Boolean(data?.orders?.length || data?.clients?.length || data?.products?.length || data?.devices?.length || data?.emergencyAlerts?.length);
}

function startCloudPolling() {
  if (!isCloudConfigured()) return;
  stopCloudPolling();
  cloudPollTimer = setInterval(() => {
    if (!state.session) return;
    const now = Date.now();
    const reason = now - lastDeviceHeartbeat > DEVICE_HEARTBEAT_MS ? "heartbeat" : "poll";
    if (reason === "heartbeat") lastDeviceHeartbeat = now;
    if (reason === "heartbeat") refreshLocationIfAllowed();
    refreshEmergencyLocationIfNeeded();
    syncWithCloud(reason);
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
      new Notification("Novo pedido Pedro Gás", { body: message, tag: latest.id });
    }
  }
}

function notifyNewEmergencyAlerts(previousEmergencyIds) {
  const alerts = (state.emergencyAlerts || []).filter((alert) => alert.active && !previousEmergencyIds.has(alert.id));
  if (!alerts.length) return;
  const latest = alerts[0];
  const who = latest.triggeredBy?.name || latest.triggeredBy?.login || "Dispositivo";
  const message = `SOS acionado por ${who}.`;
  showAppNotice(message);
  renderEmergencyOverlay();
  if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 500]);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification("SOS Pedro Gás", { body: message, tag: latest.id });
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
  } else {
    document.body.classList.add("login-mode");
  }
  if (window.lucide) window.lucide.createIcons();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}



