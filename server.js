require("dotenv").config();
const express = require("express");
const oracledb = require("oracledb");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const dbConfig = {
  user: process.env.DB_USER || "system",
  password: process.env.DB_PASSWORD || "your_password",
  connectString: process.env.DB_CONNECT_STRING || "localhost:1521/FREEPDB1"
};

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function getConnection() {
  return oracledb.getConnection(dbConfig);
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

// Products
app.get("/api/products", async (req, res) => {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(`
      SELECT p.product_id, p.product_name, p.price, p.stock_qty,
             p.is_available, c.category_name
      FROM products p
      JOIN categories c ON c.category_id = p.category_id
      WHERE p.is_available = 'Y'
      ORDER BY c.category_name, p.product_name
    `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load products", detail: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

app.get("/api/categories", async (req, res) => {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(
      `SELECT category_id, category_name FROM categories ORDER BY category_id`,
      [],
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load categories", detail: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

// Create order
app.post("/api/orders", async (req, res) => {
  const { items, paymentMethod, cashReceived } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Cart is empty." });
  }

  if (!["CASH", "CARD", "GCASH"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Invalid payment method." });
  }

  let conn;

  try {
    conn = await getConnection();
    await conn.execute("SAVEPOINT before_order");

    const ids = items.map(x => Number(x.productId)).filter(Number.isInteger);
    if (ids.length !== items.length) {
      throw new Error("Invalid product ID.");
    }

    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const quantity = Number(item.quantity);

      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Invalid quantity.");
      }

      const result = await conn.execute(
        `SELECT product_id, product_name, price, stock_qty
         FROM products
         WHERE product_id = :id
         FOR UPDATE`,
        { id: Number(item.productId) },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      if (result.rows.length === 0) {
        throw new Error(`Product ${item.productId} was not found.`);
      }

      const product = result.rows[0];

      if (product.STOCK_QTY < quantity) {
        throw new Error(`${product.PRODUCT_NAME} only has ${product.STOCK_QTY} in stock.`);
      }

      const lineTotal = money(product.PRICE * quantity);
      subtotal = money(subtotal + lineTotal);

      verifiedItems.push({
        productId: product.PRODUCT_ID,
        productName: product.PRODUCT_NAME,
        quantity,
        unitPrice: money(product.PRICE),
        subtotal: lineTotal
      });
    }

    const tax = money(subtotal * 0.12);
    const total = money(subtotal + tax);
    const cash = paymentMethod === "CASH" ? money(cashReceived) : total;

    if (paymentMethod === "CASH" && cash < total) {
      throw new Error(`Insufficient cash. Total is ₱${total.toFixed(2)}.`);
    }

    const change = paymentMethod === "CASH" ? money(cash - total) : 0;
    const orderNumber = `FB-${Date.now()}`;

    const orderResult = await conn.execute(
      `INSERT INTO orders
       (order_number, subtotal, tax_amount, total_amount,
        payment_method, cash_received, change_amount, status)
       VALUES
       (:orderNumber, :subtotal, :tax, :total,
        :paymentMethod, :cash, :changeAmount, 'COMPLETED')
       RETURNING order_id INTO :orderId`,
      {
        orderNumber,
        subtotal,
        tax,
        total,
        paymentMethod,
        cash,
        changeAmount: change,
        orderId: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
      }
    );

    const orderId = orderResult.outBinds.orderId[0];

    for (const item of verifiedItems) {
      await conn.execute(
        `INSERT INTO order_items
         (order_id, product_id, quantity, unit_price, subtotal)
         VALUES (:orderId, :productId, :quantity, :unitPrice, :subtotal)`,
        {
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal
        }
      );

      await conn.execute(
        `UPDATE products
         SET stock_qty = stock_qty - :quantity
         WHERE product_id = :productId`,
        {
          quantity: item.quantity,
          productId: item.productId
        }
      );
    }

    await conn.commit();

    res.json({
      success: true,
      order: {
        orderId,
        orderNumber,
        subtotal,
        tax,
        total,
        paymentMethod,
        cashReceived: cash,
        changeAmount: change,
        items: verifiedItems
      }
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error(err);
    res.status(400).json({ error: err.message || "Could not create order." });
  } finally {
    if (conn) await conn.close();
  }
});

// Recent orders
app.get("/api/orders", async (req, res) => {
  let conn;
  try {
    conn = await getConnection();
    const result = await conn.execute(`
      SELECT order_id, order_number, order_date, subtotal,
             tax_amount, total_amount, payment_method, status
      FROM orders
      ORDER BY order_date DESC
      FETCH FIRST 20 ROWS ONLY
    `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load orders", detail: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

// Dashboard
app.get("/api/dashboard", async (req, res) => {
  let conn;
  try {
    conn = await getConnection();

    const [sales, orders, lowStock] = await Promise.all([
      conn.execute(`
        SELECT NVL(SUM(total_amount), 0) AS total_sales,
               COUNT(*) AS order_count
        FROM orders
        WHERE TRUNC(order_date) = TRUNC(SYSDATE)
          AND status = 'COMPLETED'
      `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT }),

      conn.execute(`
        SELECT COUNT(*) AS completed_orders
        FROM orders
        WHERE TRUNC(order_date) = TRUNC(SYSDATE)
          AND status = 'COMPLETED'
      `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT }),

      conn.execute(`
        SELECT COUNT(*) AS low_stock_count
        FROM products
        WHERE stock_qty <= 10
      `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT })
    ]);

    res.json({
      totalSales: money(sales.rows[0].TOTAL_SALES),
      orderCount: Number(orders.rows[0].COMPLETED_ORDERS),
      lowStockCount: Number(lowStock.rows[0].LOW_STOCK_COUNT)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unable to load dashboard", detail: err.message });
  } finally {
    if (conn) await conn.close();
  }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`FastBite POS running at http://localhost:${PORT}`);
});