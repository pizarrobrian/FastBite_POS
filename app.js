let products = [];
let cart = [];
let selectedCategory = "ALL";
let paymentMethod = "CASH";

const peso = value => `₱${Number(value || 0).toFixed(2)}`;

document.addEventListener("DOMContentLoaded", async () => {
  setupPaymentButtons();
  document.getElementById("cashReceived").addEventListener("input", updateChange);
  updateClock();
  setInterval(updateClock, 1000);
  await refreshAll();
});

function updateClock() {
  document.getElementById("clock").textContent =
    new Date().toLocaleString("en-PH", {
      dateStyle: "medium",
      timeStyle: "short"
    });
}

async function refreshAll() {
  try {
    const [productRes, categoryRes, ordersRes, dashRes] = await Promise.all([
      fetch("/api/products"),
      fetch("/api/categories"),
      fetch("/api/orders"),
      fetch("/api/dashboard")
    ]);

    if (![productRes, categoryRes, ordersRes, dashRes].every(r => r.ok)) {
      throw new Error("Could not load POS data.");
    }

    products = await productRes.json();
    const categories = await categoryRes.json();
    const orders = await ordersRes.json();
    const dashboard = await dashRes.json();

    renderCategories(categories);
    renderProducts();
    renderOrders(orders);
    renderDashboard(dashboard);
    renderCart();
  } catch (err) {
    showToast(err.message);
  }
}

function renderCategories(categories) {
  const el = document.getElementById("categories");
  el.innerHTML = "";

  const all = document.createElement("button");
  all.className = `category-btn ${selectedCategory === "ALL" ? "active" : ""}`;
  all.textContent = "All";
  all.onclick = () => {
    selectedCategory = "ALL";
    renderCategories(categories);
    renderProducts();
  };
  el.appendChild(all);

  categories.forEach(category => {
    const btn = document.createElement("button");
    btn.className = `category-btn ${selectedCategory === category.CATEGORY_NAME ? "active" : ""}`;
    btn.textContent = category.CATEGORY_NAME;
    btn.onclick = () => {
      selectedCategory = category.CATEGORY_NAME;
      renderCategories(categories);
      renderProducts();
    };
    el.appendChild(btn);
  });
}

function iconFor(category) {
  const icons = {
    BURGERS: "🍔",
    CHICKEN: "🍗",
    SIDES: "🍟",
    DRINKS: "🥤",
    DESSERTS: "🍦"
  };
  return icons[category] || "🍽️";
}

function renderProducts() {
  const el = document.getElementById("products");
  el.innerHTML = "";

  const filtered = products.filter(p =>
    selectedCategory === "ALL" || p.CATEGORY_NAME === selectedCategory
  );

  filtered.forEach(p => {
    const card = document.createElement("article");
    card.className = "product-card";
    card.onclick = () => addToCart(p);

    const stockText = p.STOCK_QTY <= 10
      ? `Low stock: ${p.STOCK_QTY}`
      : `Stock: ${p.STOCK_QTY}`;

    card.innerHTML = `
      <div class="product-icon">${iconFor(p.CATEGORY_NAME)}</div>
      <h3>${escapeHtml(p.PRODUCT_NAME)}</h3>
      <div class="category">${escapeHtml(p.CATEGORY_NAME)}</div>
      <div class="price">${peso(p.PRICE)}</div>
      <div class="stock">${stockText}</div>
    `;

    el.appendChild(card);
  });
}

function addToCart(product) {
  if (product.STOCK_QTY <= 0) {
    showToast("This product is out of stock.");
    return;
  }

  const existing = cart.find(x => x.productId === product.PRODUCT_ID);

  if (existing) {
    if (existing.quantity >= product.STOCK_QTY) {
      showToast("You cannot add more than available stock.");
      return;
    }
    existing.quantity++;
  } else {
    cart.push({
      productId: product.PRODUCT_ID,
      name: product.PRODUCT_NAME,
      price: Number(product.PRICE),
      stock: Number(product.STOCK_QTY),
      quantity: 1
    });
  }

  renderCart();
}

function changeQty(productId, amount) {
  const item = cart.find(x => x.productId === productId);
  if (!item) return;

  item.quantity += amount;

  if (item.quantity <= 0) {
    cart = cart.filter(x => x.productId !== productId);
  } else if (item.quantity > item.stock) {
    item.quantity = item.stock;
    showToast("Maximum available stock reached.");
  }

  renderCart();
}

function clearCart() {
  cart = [];
  renderCart();
}

function getTotals() {
  const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = subtotal * 0.12;
  const total = subtotal + tax;
  return { subtotal, tax, total };
}

function renderCart() {
  const el = document.getElementById("cart");
  el.innerHTML = "";

  if (cart.length === 0) {
    el.innerHTML = `<div class="empty-cart">Your order is empty.</div>`;
  } else {
    cart.forEach(item => {
      const row = document.createElement("div");
      row.className = "cart-item";
      row.innerHTML = `
        <div class="cart-item-top">
          <h4>${escapeHtml(item.name)}</h4>
          <span class="cart-price">${peso(item.price * item.quantity)}</span>
        </div>
        <div class="qty-controls">
          <button onclick="changeQty(${item.productId}, -1)">−</button>
          <span>${item.quantity}</span>
          <button onclick="changeQty(${item.productId}, 1)">+</button>
        </div>
      `;
      el.appendChild(row);
    });
  }

  const { subtotal, tax, total } = getTotals();

  document.getElementById("subtotal").textContent = peso(subtotal);
  document.getElementById("tax").textContent = peso(tax);
  document.getElementById("total").textContent = peso(total);
  document.getElementById("orderLabel").textContent =
    cart.length ? `${cart.reduce((s, x) => s + x.quantity, 0)} item(s)` : "No items";

  updateChange();
}

function setupPaymentButtons() {
  document.querySelectorAll(".pay-option").forEach(btn => {
    btn.addEventListener("click", () => {
      paymentMethod = btn.dataset.method;

      document.querySelectorAll(".pay-option").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      document.getElementById("cashLabel").style.display =
        paymentMethod === "CASH" ? "block" : "none";

      updateChange();
    });
  });
}

function updateChange() {
  const { total } = getTotals();
  const cash = Number(document.getElementById("cashReceived").value || 0);

  let change = 0;
  if (paymentMethod === "CASH") {
    change = Math.max(0, cash - total);
  }

  document.getElementById("change").textContent = peso(change);
}

async function checkout() {
  if (cart.length === 0) {
    showToast("Add at least one item.");
    return;
  }

  const { subtotal, tax, total } = getTotals();
  const cashReceived = Number(document.getElementById("cashReceived").value || 0);

  if (paymentMethod === "CASH" && cashReceived < total) {
    showToast(`Insufficient cash. Need ${peso(total - cashReceived)} more.`);
    return;
  }

  const btn = document.getElementById("checkoutBtn");
  btn.disabled = true;
  btn.textContent = "Processing...";

  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: cart.map(item => ({
          productId: item.productId,
          quantity: item.quantity
        })),
        paymentMethod,
        cashReceived
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Checkout failed.");
    }

    showReceipt(data.order);
    cart = [];
    document.getElementById("cashReceived").value = "";
    await refreshAll();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Complete Order";
  }
}

function showReceipt(order) {
  const content = document.getElementById("receiptContent");

  content.innerHTML = `
    <h2>Order Complete</h2>
    <p><strong>${escapeHtml(order.orderNumber)}</strong></p>
    <hr>
    ${order.items.map(item => `
      <div class="receipt-line">
        <span>${item.quantity} × ${escapeHtml(item.productName)}</span>
        <strong>${peso(item.subtotal)}</strong>
      </div>
    `).join("")}
    <hr>
    <div class="receipt-line"><span>Subtotal</span><strong>${peso(order.subtotal)}</strong></div>
    <div class="receipt-line"><span>VAT</span><strong>${peso(order.tax)}</strong></div>
    <div class="receipt-line"><span>Total</span><strong>${peso(order.total)}</strong></div>
    <div class="receipt-line"><span>Payment</span><strong>${order.paymentMethod}</strong></div>
    ${order.paymentMethod === "CASH"
      ? `<div class="receipt-line"><span>Cash</span><strong>${peso(order.cashReceived)}</strong></div>
         <div class="receipt-line"><span>Change</span><strong>${peso(order.changeAmount)}</strong></div>`
      : ""}
  `;

  document.getElementById("receiptModal").classList.remove("hidden");
}

function closeReceipt() {
  document.getElementById("receiptModal").classList.add("hidden");
}

function renderOrders(orders) {
  const tbody = document.getElementById("ordersTable");
  tbody.innerHTML = "";

  orders.forEach(order => {
    const date = new Date(order.ORDER_DATE);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(order.ORDER_NUMBER)}</td>
      <td>${isNaN(date) ? order.ORDER_DATE : date.toLocaleString("en-PH")}</td>
      <td>${peso(order.TOTAL_AMOUNT)}</td>
      <td>${escapeHtml(order.PAYMENT_METHOD)}</td>
      <td>${escapeHtml(order.STATUS)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDashboard(data) {
  document.getElementById("dashSales").textContent = peso(data.totalSales);
  document.getElementById("dashOrders").textContent = data.orderCount;
  document.getElementById("dashLowStock").textContent = data.lowStockCount;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
